mod backup;

#[tauri::command]
async fn load_meiryo_font() -> Result<Vec<u8>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        use std::{collections::HashSet, fs, path::PathBuf};

        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Some(windir) = std::env::var_os("WINDIR") {
            candidates.push(PathBuf::from(windir).join("Fonts").join("meiryo.ttc"));
        }
        candidates.push(PathBuf::from(r"C:\Windows\Fonts\meiryo.ttc"));

        let mut seen = HashSet::new();
        for path in candidates {
            if !seen.insert(path.clone()) {
                continue;
            }
            let bytes = match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(_) => continue,
            };
            return extract_ttc_face(&bytes, 0).map_err(|e| {
                format!(
                    "Meiryo TTC extraction failed ({}): {e}",
                    path.to_string_lossy()
                )
            });
        }

        Err("Meiryo font not found".to_string())
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {}", e))?
}

fn extract_ttc_face(ttc: &[u8], face_index: usize) -> Result<Vec<u8>, String> {
    if ttc.len() < 12 || &ttc[0..4] != b"ttcf" {
        return Err("not a TTC font".to_string());
    }

    let num_fonts = read_u32(ttc, 8)? as usize;
    if face_index >= num_fonts {
        return Err("TTC face index out of range".to_string());
    }

    let offset_pos = 12usize
        .checked_add(face_index.checked_mul(4).ok_or("offset overflow")?)
        .ok_or("offset overflow")?;
    let font_offset = read_u32(ttc, offset_pos)? as usize;
    let num_tables = read_u16(ttc, font_offset + 4)? as usize;
    if num_tables == 0 {
        return Err("TTC face has no tables".to_string());
    }
    let table_dir = font_offset.checked_add(12).ok_or("table dir overflow")?;

    let header_len = 12usize
        .checked_add(num_tables.checked_mul(16).ok_or("header overflow")?)
        .ok_or("header overflow")?;
    let mut data_offset = header_len;
    let mut tables: Vec<TtcTable> = Vec::with_capacity(num_tables);

    for i in 0..num_tables {
        let rec = table_dir
            .checked_add(i.checked_mul(16).ok_or("record overflow")?)
            .ok_or("record overflow")?;
        let tag = ttc
            .get(rec..rec + 4)
            .ok_or("table tag out of bounds")?
            .try_into()
            .map_err(|_| "invalid table tag")?;
        let old_offset = read_u32(ttc, rec + 8)? as usize;
        let length = read_u32(ttc, rec + 12)? as usize;
        let old_end = old_offset.checked_add(length).ok_or("table overflow")?;
        if old_end > ttc.len() {
            return Err("table data out of bounds".to_string());
        }
        tables.push(TtcTable {
            tag,
            old_offset,
            length,
            new_offset: data_offset,
        });
        data_offset = data_offset
            .checked_add(pad4(length))
            .ok_or("font output overflow")?;
    }

    let mut out = vec![0u8; data_offset];
    let sfnt_version = read_u32(ttc, font_offset)?;
    write_u32(&mut out, 0, sfnt_version)?;
    write_u16(&mut out, 4, num_tables as u16)?;
    let max_power = 1usize << (usize::BITS as usize - 1 - num_tables.leading_zeros() as usize);
    let search_range = max_power * 16;
    let entry_selector = max_power.trailing_zeros() as u16;
    let range_shift = num_tables * 16 - search_range;
    write_u16(&mut out, 6, search_range as u16)?;
    write_u16(&mut out, 8, entry_selector)?;
    write_u16(&mut out, 10, range_shift as u16)?;

    for table in &tables {
        let source_end = table
            .old_offset
            .checked_add(table.length)
            .ok_or("table data overflow")?;
        let target_end = table
            .new_offset
            .checked_add(table.length)
            .ok_or("font output overflow")?;
        let source = ttc
            .get(table.old_offset..source_end)
            .ok_or("table data out of bounds")?;
        let target = out
            .get_mut(table.new_offset..target_end)
            .ok_or("font output out of bounds")?;
        target.copy_from_slice(source);
        if &table.tag == b"head" {
            write_u32(&mut out, table.new_offset + 8, 0)?;
        }
    }

    for (i, table) in tables.iter().enumerate() {
        let rec = 12 + i * 16;
        let table_checksum = checksum(&out, table.new_offset, table.length);
        out.get_mut(rec..rec + 4)
            .ok_or("table record out of bounds")?
            .copy_from_slice(&table.tag);
        write_u32(&mut out, rec + 4, table_checksum)?;
        write_u32(&mut out, rec + 8, table.new_offset as u32)?;
        write_u32(&mut out, rec + 12, table.length as u32)?;
    }

    let head = tables
        .iter()
        .find(|table| &table.tag == b"head")
        .ok_or("head table not found")?;
    let adjustment = 0xB1B0AFBAu32.wrapping_sub(checksum(&out, 0, out.len()));
    write_u32(&mut out, head.new_offset + 8, adjustment)?;
    Ok(out)
}

struct TtcTable {
    tag: [u8; 4],
    old_offset: usize,
    length: usize,
    new_offset: usize,
}

fn pad4(value: usize) -> usize {
    (value + 3) & !3
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, String> {
    let slice = bytes
        .get(offset..offset + 2)
        .ok_or("read_u16 out of bounds")?;
    Ok(u16::from_be_bytes([slice[0], slice[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let slice = bytes
        .get(offset..offset + 4)
        .ok_or("read_u32 out of bounds")?;
    Ok(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn write_u16(bytes: &mut [u8], offset: usize, value: u16) -> Result<(), String> {
    let target = bytes
        .get_mut(offset..offset + 2)
        .ok_or("write_u16 out of bounds")?;
    target.copy_from_slice(&value.to_be_bytes());
    Ok(())
}

fn write_u32(bytes: &mut [u8], offset: usize, value: u32) -> Result<(), String> {
    let target = bytes
        .get_mut(offset..offset + 4)
        .ok_or("write_u32 out of bounds")?;
    target.copy_from_slice(&value.to_be_bytes());
    Ok(())
}

fn checksum(bytes: &[u8], start: usize, length: usize) -> u32 {
    let mut sum = 0u32;
    let end = start.saturating_add(pad4(length));
    let mut offset = start;
    while offset < end {
        let b0 = bytes.get(offset).copied().unwrap_or(0) as u32;
        let b1 = bytes.get(offset + 1).copied().unwrap_or(0) as u32;
        let b2 = bytes.get(offset + 2).copied().unwrap_or(0) as u32;
        let b3 = bytes.get(offset + 3).copied().unwrap_or(0) as u32;
        sum = sum.wrapping_add((b0 << 24) | (b1 << 16) | (b2 << 8) | b3);
        offset += 4;
    }
    sum
}

/// PDF の /MediaBox (or /CropBox) を直接パースし、全ページの論理寸法を返す。
/// pdfjs の getPage().getViewport() と比較して10倍以上高速。
/// 各タプルは (width_pt, height_pt)。/Rotate 90/270 は swap 済み。
/// パース不能ページは (0.0, 0.0) を返す。load 失敗時のみ Err を返す。
#[tauri::command]
async fn get_pdf_page_dimensions(
    app: tauri::AppHandle,
    file_path: String,
) -> Result<Vec<(f64, f64)>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<(f64, f64)>, String> {
        use lopdf::{Document, Object, ObjectId};

        let file = validate_allowed_existing_pdf_file_path(&app, &file_path)?;
        let doc = Document::load(&file).map_err(|e| format!("PDF load failed: {}", e))?;

        // Page object から /MediaBox (fallback: /CropBox) を親 Pages ツリーに
        // 遡って取得する。見つからなければ None。
        fn find_box(doc: &Document, page_id: ObjectId) -> Option<[f64; 4]> {
            let mut current = page_id;
            // 循環参照対策に上限を設定
            for _ in 0..32 {
                let dict = match doc.get_object(current).and_then(|o| o.as_dict()) {
                    Ok(d) => d,
                    Err(_) => return None,
                };
                for key in ["MediaBox", "CropBox"] {
                    if let Ok(obj) = dict.get(key.as_bytes()) {
                        let resolved = match obj {
                            Object::Reference(id) => doc.get_object(*id).ok(),
                            other => Some(other),
                        };
                        if let Some(arr_obj) = resolved {
                            if let Ok(arr) = arr_obj.as_array() {
                                if arr.len() == 4 {
                                    let parse = |o: &Object| -> Option<f64> {
                                        match o {
                                            Object::Integer(i) => Some(*i as f64),
                                            Object::Real(r) => Some(*r as f64),
                                            _ => None,
                                        }
                                    };
                                    if let (Some(a), Some(b), Some(c), Some(d)) = (
                                        parse(&arr[0]),
                                        parse(&arr[1]),
                                        parse(&arr[2]),
                                        parse(&arr[3]),
                                    ) {
                                        return Some([a, b, c, d]);
                                    }
                                }
                            }
                        }
                    }
                }
                // 親へ遡る
                match dict.get(b"Parent") {
                    Ok(Object::Reference(parent_id)) => current = *parent_id,
                    _ => return None,
                }
            }
            None
        }

        // /Rotate を親ツリーに遡って取得。見つからなければ 0。
        fn find_rotate(doc: &Document, page_id: ObjectId) -> i64 {
            let mut current = page_id;
            for _ in 0..32 {
                let dict = match doc.get_object(current).and_then(|o| o.as_dict()) {
                    Ok(d) => d,
                    Err(_) => return 0,
                };
                if let Ok(obj) = dict.get(b"Rotate") {
                    let resolved = match obj {
                        Object::Reference(id) => doc.get_object(*id).ok(),
                        other => Some(other),
                    };
                    if let Some(r) = resolved {
                        match r {
                            Object::Integer(i) => return *i,
                            Object::Real(f) => return *f as i64,
                            _ => {}
                        }
                    }
                }
                match dict.get(b"Parent") {
                    Ok(Object::Reference(parent_id)) => current = *parent_id,
                    _ => return 0,
                }
            }
            0
        }

        let pages = doc.get_pages();
        let mut dims: Vec<(f64, f64)> = Vec::with_capacity(pages.len());
        // get_pages() は BTreeMap<u32, ObjectId> でページ番号順にソート済み
        for (_page_no, page_id) in pages.iter() {
            let bbox = match find_box(&doc, *page_id) {
                Some(b) => b,
                None => {
                    dims.push((0.0, 0.0));
                    continue;
                }
            };
            let width = (bbox[2] - bbox[0]).abs();
            let height = (bbox[3] - bbox[1]).abs();
            let rotate = ((find_rotate(&doc, *page_id) % 360) + 360) % 360;
            let (w, h) = if rotate == 90 || rotate == 270 {
                (height, width)
            } else {
                (width, height)
            };
            dims.push((w, h));
        }
        Ok(dims)
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {}", e))?
}

#[tauri::command]
async fn list_pdf_files_in_folder(
    app: tauri::AppHandle,
    folder_path: String,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
        use std::fs;

        let folder = validate_allowed_directory_path(&app, &folder_path)?;
        let mut paths = Vec::new();
        for entry in fs::read_dir(&folder).map_err(|e| format!("read_dir failed: {e}"))? {
            let entry = entry.map_err(|e| format!("read_dir entry failed: {e}"))?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
            {
                paths.push(path.to_string_lossy().to_string());
            }
        }
        paths.sort();
        Ok(paths)
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {}", e))?
}

/// 計測ログを appLocalData/perf/<safe_name>.ndjson に書き出す。
/// name はファイル名衝突 / path traversal 対策として ASCII 英数字と '-', '_' のみを許可。
/// 返値は書き込み先の絶対パス文字列。
#[tauri::command]
async fn write_perf_log(
    app: tauri::AppHandle,
    name: String,
    body: String,
) -> Result<String, String> {
    use std::fs;
    use tauri::Manager;
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let perf_dir = dir.join("perf");
    fs::create_dir_all(&perf_dir).map_err(|e| format!("create_dir: {e}"))?;
    let safe_name: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let safe_name = if safe_name.is_empty() {
        format!(
            "perf-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        )
    } else {
        safe_name
    };
    let path = perf_dir.join(format!("{}.ndjson", safe_name));
    fs::write(&path, body).map_err(|e| format!("write: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 操作ログを appLocalData/logs/<safe_name>.ndjson に書き出す。
/// `write_perf_log` と同様に name は ASCII 英数字 + '-', '_' のみ許可。
/// 返値は書き込み先の絶対パス文字列。
#[tauri::command]
async fn write_operation_log(
    app: tauri::AppHandle,
    name: String,
    body: String,
) -> Result<String, String> {
    use std::fs;
    use tauri::Manager;
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let logs_dir = dir.join("logs");
    fs::create_dir_all(&logs_dir).map_err(|e| format!("create_dir: {e}"))?;
    let safe_name: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let safe_name = if safe_name.is_empty() {
        format!(
            "log-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        )
    } else {
        safe_name
    };
    let path = logs_dir.join(format!("{}.ndjson", safe_name));
    fs::write(&path, body).map_err(|e| format!("write: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 監査ログを `appLocalData/pecotool/audit/<YYYY-MM-DD>.ndjson` に **追記** する。
/// body は NDJSON の 1 行（呼び出し元が JSON 文字列を渡す）。
/// 返値は書き込み先の絶対パス文字列。
#[tauri::command]
async fn write_audit_log(
    app: tauri::AppHandle,
    body: String,
) -> Result<String, String> {
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use tauri::Manager;

    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let audit_dir = dir.join("pecotool").join("audit");
    fs::create_dir_all(&audit_dir).map_err(|e| format!("create_dir: {e}"))?;

    // ファイル名は UTC の YYYY-MM-DD
    let date_str = {
        use std::time::{SystemTime, UNIX_EPOCH};
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let days = secs / 86400;
        // ユリウス日から年月日を算出 (グレゴリオ暦、UTC)
        let j = days as i64 + 2440588; // Unix epoch = JD 2440588
        let f = j + 1401 + (((4 * j + 274277) / 146097) * 3) / 4 - 38;
        let e = 4 * f + 3;
        let g = (e % 1461) / 4;
        let h = 5 * g + 2;
        let day = (h % 153) / 5 + 1;
        let month = (h / 153 + 2) % 12 + 1;
        let year = e / 1461 - 4716 + (14 - month) / 12;
        format!("{:04}-{:02}-{:02}", year, month, day)
    };

    let path = audit_dir.join(format!("{}.ndjson", date_str));
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open audit log: {e}"))?;
    writeln!(file, "{}", body).map_err(|e| format!("write audit log: {e}"))?;

    Ok(path.to_string_lossy().to_string())
}

/// `appLocalData/logs/` を OS 標準ファイラで開く。
/// 未作成なら先に `fs::create_dir_all` で生成する。
#[tauri::command]
async fn open_log_folder(app: tauri::AppHandle) -> Result<(), String> {
    use std::fs;
    use tauri::Manager;
    use tauri_plugin_opener::OpenerExt;
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let logs_dir = dir.join("logs");
    fs::create_dir_all(&logs_dir).map_err(|e| format!("create_dir: {e}"))?;
    app.opener()
        .open_path(logs_dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("open_path failed: {e}"))?;
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct OcrLanguageInfo {
    tag: String,
    display_name: String,
}

#[tauri::command]
async fn list_ocr_languages() -> Result<Vec<OcrLanguageInfo>, String> {
    tokio::task::spawn_blocking(|| {
        use windows::{
            Media::Ocr::OcrEngine,
            Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
        };

        let needs_uninit = unsafe {
            let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            if hr.is_err() && hr.0 != 0x00000001u32 as i32 {
                return Err(format!("COM初期化失敗: {:?}", hr));
            }
            hr.0 == 0 || hr.0 == 1
        };

        struct ComGuard;
        impl Drop for ComGuard {
            fn drop(&mut self) {
                unsafe { CoUninitialize() };
            }
        }
        let _com_guard = if needs_uninit { Some(ComGuard) } else { None };

        let langs = OcrEngine::AvailableRecognizerLanguages()
            .map_err(|e| format!("言語リスト取得失敗: {e}"))?;
        let count = langs.Size().map_err(|e| format!("言語数取得失敗: {e}"))?;

        let mut result = Vec::with_capacity(count as usize);
        for i in 0..count {
            let lang = langs.GetAt(i).map_err(|e| format!("言語取得失敗 [{}]: {e}", i))?;
            let tag = lang
                .LanguageTag()
                .map_err(|e| format!("LanguageTag取得失敗: {e}"))?
                .to_string();
            let display_name = lang
                .DisplayName()
                .map_err(|e| format!("DisplayName取得失敗: {e}"))?
                .to_string();
            result.push(OcrLanguageInfo { tag, display_name });
        }
        Ok(result)
    })
    .await
    .map_err(|e| format!("スレッドエラー: {}", e))?
}

/// Write `bytes` to a uniquely-named temp file, run OCR on it, then clean up.
/// The temp file lives in `std::env::temp_dir()` and is never subject to Tauri
/// fs-scope validation, so the `\\?\`-prefix canonicalization issue (#285) cannot
/// occur here.
#[tauri::command]
async fn run_ocr(
    image_bytes: Vec<u8>,
    page_width: f64,
    page_height: f64,
    render_scale: f64,
    language_tag: Option<String>,
) -> Result<String, String> {
    let _ = (page_width, page_height); // 座標変換は render_scale のみ使用
    let result = tokio::task::spawn_blocking(move || {
        let temp_path = write_ocr_temp_bytes(&image_bytes)?;
        let image = temp_path.to_string_lossy().to_string();
        let tag = language_tag.unwrap_or_else(|| "ja".to_string());
        let ocr_result = do_windows_ocr(&image, render_scale, &tag);
        let _ = std::fs::remove_file(&temp_path);
        ocr_result
    })
    .await
    .map_err(|e| format!("スレッドエラー: {}", e))??;
    Ok(result)
}

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static OCR_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Write image bytes to a uniquely-named temp PNG and return its path.
/// Uses `std::env::temp_dir()` directly, bypassing Tauri fs-scope checks.
/// Uniqueness is guaranteed by combining PID, nanosecond timestamp, and a
/// per-process monotonic counter — preventing collisions even when the same
/// bytes (and therefore the same pointer) are written in rapid succession.
pub(crate) fn write_ocr_temp_bytes(bytes: &[u8]) -> Result<std::path::PathBuf, String> {
    let temp_dir = std::env::temp_dir();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let counter = OCR_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp_path = temp_dir.join(format!(
        "peco_ocr_{}_{}_{}.png",
        std::process::id(),
        nanos,
        counter,
    ));
    std::fs::write(&temp_path, bytes).map_err(|e| format!("temp write failed: {}", e))?;
    Ok(temp_path)
}

/// Heuristic OCR confidence (0.0..=1.0).
///
/// Windows.Media.Ocr does not expose per-word confidence, so we approximate
/// based on simple text/geometry signals. This is a heuristic for highlighting
/// "likely-misread" blocks, not an actual model probability.
fn estimate_confidence(text: &str, width: f64, height: f64) -> f64 {
    // 1) Empty text: very likely garbage
    if text.is_empty() {
        return 0.3;
    }
    let char_count = text.chars().count() as f64;
    // 2) Single character: unstable read
    if char_count == 1.0 {
        return 0.5;
    }
    // 3) High symbol ratio (ASCII punctuation + fullwidth symbols) -> low confidence
    let symbol_count = text
        .chars()
        .filter(|c| {
            c.is_ascii_punctuation()
                || matches!(*c, '\u{3000}'..='\u{303F}')  // CJK punctuation
                || matches!(*c, '\u{FF00}'..='\u{FF1F}')  // Fullwidth ASCII symbols
        })
        .count() as f64;
    let symbol_ratio = symbol_count / char_count;
    if symbol_ratio > 0.5 {
        return 0.5;
    }
    // 4) Extreme aspect ratio (very wide or very narrow box) -> likely mis-segmented
    let aspect = if height > 0.0 { width / height } else { 1.0 };
    if aspect > 20.0 || aspect < 0.05 {
        return 0.5;
    }
    // 5) Normal block: high confidence
    0.9
}

fn do_windows_ocr(image_path: &str, render_scale: f64, language_tag: &str) -> Result<String, String> {
    use windows::{
        core::HSTRING,
        Globalization::Language,
        Graphics::Imaging::BitmapDecoder,
        Media::Ocr::OcrEngine,
        Storage::{FileAccessMode, StorageFile},
        Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
    };

    // このスレッドの COM 初期化
    // S_OK (0)      = 初期化成功 → 関数終了時に CoUninitialize が必要
    // S_FALSE (1)   = 既に初期化済みだが、この呼び出しに対応する CoUninitialize が必要
    // それ以外       = 失敗
    let needs_uninit = unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() && hr.0 != 0x00000001u32 as i32 {
            return Err(format!("COM初期化失敗: {:?}", hr));
        }
        hr.0 == 0 || hr.0 == 1
    };

    struct ComGuard;
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }
    let _com_guard = if needs_uninit { Some(ComGuard) } else { None };

    let path_h = HSTRING::from(image_path);

    let file = StorageFile::GetFileFromPathAsync(&path_h)
        .map_err(|e| format!("ファイルオープン失敗: {e}"))?
        .get()
        .map_err(|e| format!("ファイルオープン待機失敗: {e}"))?;

    let stream = file
        .OpenAsync(FileAccessMode::Read)
        .map_err(|e| format!("ストリームオープン失敗: {e}"))?
        .get()
        .map_err(|e| format!("ストリームオープン待機失敗: {e}"))?;

    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|e| format!("デコーダー作成失敗: {e}"))?
        .get()
        .map_err(|e| format!("デコーダー作成待機失敗: {e}"))?;

    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|e| format!("ビットマップ取得失敗: {e}"))?
        .get()
        .map_err(|e| format!("ビットマップ取得待機失敗: {e}"))?;

    let lang =
        Language::CreateLanguage(&HSTRING::from(language_tag)).map_err(|e| format!("言語設定失敗 ({}): {e}", language_tag))?;

    let engine = OcrEngine::TryCreateFromLanguage(&lang)
        .map_err(|e| format!(
            "OCRエンジン作成失敗 ({}): {e}。言語パックがインストールされていない可能性があります。Windows の設定 > 時刻と言語 > 言語と地域 から対象言語を追加してください。",
            language_tag
        ))?;

    let ocr_result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| format!("OCR実行失敗: {e}"))?
        .get()
        .map_err(|e| format!("OCR結果待機失敗: {e}"))?;

    let lines = ocr_result
        .Lines()
        .map_err(|e| format!("行リスト取得失敗: {e}"))?;

    let line_count = lines.Size().map_err(|e| format!("行数取得失敗: {e}"))?;
    let mut blocks: Vec<serde_json::Value> = Vec::new();

    for i in 0..line_count {
        let line = lines.GetAt(i).map_err(|e| format!("行取得失敗: {e}"))?;
        let words = line
            .Words()
            .map_err(|e| format!("ワードリスト取得失敗: {e}"))?;
        let word_count = words.Size().map_err(|e| format!("ワード数取得失敗: {e}"))?;

        if word_count == 0 {
            continue;
        }

        let mut min_x = f32::MAX;
        let mut min_y = f32::MAX;
        let mut max_x = f32::MIN;
        let mut max_y = f32::MIN;
        let mut text_parts: Vec<String> = Vec::new();

        for j in 0..word_count {
            let word = words.GetAt(j).map_err(|e| format!("ワード取得失敗: {e}"))?;
            let rect = word
                .BoundingRect()
                .map_err(|e| format!("bbox取得失敗: {e}"))?;
            min_x = min_x.min(rect.X);
            min_y = min_y.min(rect.Y);
            max_x = max_x.max(rect.X + rect.Width);
            max_y = max_y.max(rect.Y + rect.Height);
            text_parts.push(
                word.Text()
                    .map_err(|e| format!("テキスト取得失敗: {e}"))?
                    .to_string(),
            );
        }

        let x = (min_x as f64) / render_scale;
        let y = (min_y as f64) / render_scale;
        let w = ((max_x - min_x) as f64) / render_scale;
        let h = ((max_y - min_y) as f64) / render_scale;

        // 縦書き判定:
        // 1. アスペクト比 (高さ > 幅 * 1.5) → 縦書き
        // 2. 複数ワードがある場合、Y座標の差分がX座標の差分より大きい → 縦書き
        // 3. 単一ワードの場合もアスペクト比で判定済みのため horizontal にフォールバック
        let writing_mode = if h > w * 1.5 {
            "vertical"
        } else if word_count > 1 {
            let first_word = words
                .GetAt(0)
                .map_err(|e| format!("Word(0)取得失敗: {e}"))?;
            let last_word = words
                .GetAt(word_count - 1)
                .map_err(|e| format!("Word(last)取得失敗: {e}"))?;
            let first_rect = first_word
                .BoundingRect()
                .map_err(|e| format!("BBox(0)取得失敗: {e}"))?;
            let last_rect = last_word
                .BoundingRect()
                .map_err(|e| format!("BBox(last)取得失敗: {e}"))?;
            let dy = (last_rect.Y - first_rect.Y).abs();
            let dx = (last_rect.X - first_rect.X).abs();
            if dy > dx * 2.0 {
                "vertical"
            } else {
                "horizontal"
            }
        } else {
            // word_count == 1: アスペクト比条件（h > w * 1.5）で判定済み。
            // ここに来た場合は幅が高さと同程度かそれ以上なので横書きとみなす。
            "horizontal"
        };

        let text = text_parts.join("");
        let confidence = estimate_confidence(&text, w, h);
        blocks.push(serde_json::json!({
            "text": text,
            "bbox": { "x": x, "y": y, "width": w, "height": h },
            "writingMode": writing_mode,
            "confidence": confidence
        }));
    }

    Ok(serde_json::json!({ "status": "ok", "blocks": blocks }).to_string())
}

/// PDF bytes チャンクを指定パスに書き込む。
///
/// Tauri plugin-fs の writeFile や通常の `#[tauri::command]` with `Vec<u8>` では
/// 100MB の一括転送が IPC レイヤで hang する事例が観測された。
/// このコマンドは `tauri::ipc::Request` の **raw body** を直接受け、
/// JSON シリアライズを完全回避する。
///
/// プロトコル:
/// - HTTP-like headers でメタ情報を受け渡し: `x-path` (URL-encoded path), `x-offset` (bytes)
/// - 最初のチャンクは offset=0 → ファイルを truncate
/// - 後続は offset 指定で追記
/// - 中断時は一時 `.tmp` が残り得るが、`replace_pdf_file` まで正式 PDF は不変。
///   次回の offset=0 書き込みで truncate されるため、残骸は上書き/掃除対象として扱う。
///
/// フロント側はバイナリを Uint8Array のまま `invoke(cmd, bytes, { headers })` で渡す。
#[tauri::command]
async fn write_pdf_chunk(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    use std::fs::OpenOptions;
    use std::io::{Seek, SeekFrom, Write};

    let headers = request.headers();
    let path_raw = headers
        .get("x-path")
        .and_then(|h| h.to_str().ok())
        .ok_or_else(|| "missing x-path header".to_string())?;
    let path = percent_decode(path_raw);
    let offset = parse_pdf_chunk_offset(headers)?;

    let bytes: Vec<u8> = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        _ => return Err("[write_pdf_chunk] expected raw body".to_string()),
    };

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let path = normalize_child_path(&path)?;
        let target = temp_target_path(&path)?;
        validate_pdf_file_name(&target)?;
        validate_allowed_resolved_path(&app, &target)?;

        // 最初のチャンク (offset==0) は create + truncate、後続は create 無しで open
        let mut opts = OpenOptions::new();
        opts.write(true);
        if offset == 0 {
            opts.create(true).truncate(true);
        } else {
            opts.create(false).truncate(false);
        }
        let mut f = opts
            .open(&path)
            .map_err(|e| format!("open failed: {} ({})", e, path.to_string_lossy()))?;
        let current_len = f
            .metadata()
            .map_err(|e| format!("metadata failed: {}", e))?
            .len();
        validate_pdf_chunk_offset_contiguous(current_len, offset)?;
        if offset > 0 {
            f.seek(SeekFrom::Start(offset))
                .map_err(|e| format!("seek failed: {}", e))?;
        }
        f.write_all(&bytes)
            .map_err(|e| format!("write failed: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {}", e))?
}

/// チャンク書き込み済みの一時 PDF を正式ファイルへ置き換える。
/// Windows では `rename(temp, target)` が既存ファイルを上書きできないため、
/// 既存 target を同一ディレクトリのバックアップへ退避してから temp を target に移動する。
#[tauri::command]
async fn replace_pdf_file(
    app: tauri::AppHandle,
    temp_path: String,
    target_path: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        use std::fs;
        use std::time::{SystemTime, UNIX_EPOCH};

        let temp = normalize_child_path(&temp_path)?;
        let target = validate_allowed_pdf_target_path(&app, &target_path)?;
        validate_pdf_temp_target(&temp, &target)?;
        if !temp.exists() {
            return Err(format!("temp file does not exist: {}", temp_path));
        }
        let temp_metadata = fs::metadata(&temp)
            .map_err(|e| format!("metadata failed: {e} ({})", temp_path))?;
        if !temp_metadata.is_file() {
            return Err("temp path must be a file".to_string());
        }
        let len = temp_metadata.len();
        if len == 0 {
            return Err("temp file is empty".to_string());
        }

        if !target.exists() {
            fs::rename(&temp, &target)
                .map_err(|e| format!("rename temp->target failed: {e}"))?;
            return Ok(());
        }

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let backup = target.with_extension(format!("pecotool-backup-{}.tmp", stamp));

        fs::rename(&target, &backup)
            .map_err(|e| format!("rename target->backup failed: {e}"))?;

        match fs::rename(&temp, &target) {
            Ok(()) => {
                if let Err(e) = fs::remove_file(&backup) {
                    eprintln!(
                        "replace_pdf_file succeeded, but stale backup cleanup failed: {e}; cleanup target: {}",
                        backup.to_string_lossy()
                    );
                }
                Ok(())
            }
            Err(e) => {
                let restore_result = fs::rename(&backup, &target);
                let _ = fs::remove_file(&temp);
                match restore_result {
                    Ok(()) => Err(format!("rename temp->target failed, original restored: {e}")),
                    Err(restore_err) => Err(format!(
                        "rename temp->target failed ({e}); restore failed ({restore_err}); backup: {}",
                        backup.to_string_lossy()
                    )),
                }
            }
        }
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {}", e))?
}

fn normalize_child_path(path: &str) -> Result<std::path::PathBuf, String> {
    use std::path::PathBuf;

    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("path must be absolute".to_string());
    }

    let parent = path
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?
        .canonicalize()
        .map_err(|e| format!("canonicalize parent failed: {e}"))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "path has no file name".to_string())?;
    Ok(parent.join(file_name))
}

fn validate_allowed_path(app: &tauri::AppHandle, path: &str) -> Result<std::path::PathBuf, String> {
    let resolved = normalize_child_path(path)?;
    validate_allowed_resolved_path(app, &resolved)?;
    Ok(resolved)
}

fn validate_allowed_existing_file_path(
    app: &tauri::AppHandle,
    path: &str,
) -> Result<std::path::PathBuf, String> {
    let path = std::path::PathBuf::from(path);
    if !path.is_absolute() {
        return Err("path must be absolute".to_string());
    }
    let resolved = path
        .canonicalize()
        .map_err(|e| format!("canonicalize file failed: {e}"))?;
    if !resolved.is_file() {
        return Err("path must be a file".to_string());
    }
    validate_allowed_resolved_path(app, &resolved)?;
    Ok(resolved)
}

fn validate_allowed_existing_pdf_file_path(
    app: &tauri::AppHandle,
    path: &str,
) -> Result<std::path::PathBuf, String> {
    let file = validate_allowed_existing_file_path(app, path)?;
    validate_pdf_file_name(&file)?;
    Ok(file)
}

fn validate_allowed_pdf_target_path(
    app: &tauri::AppHandle,
    path: &str,
) -> Result<std::path::PathBuf, String> {
    let target = validate_allowed_path(app, path)?;
    validate_pdf_file_name(&target)?;
    if target.exists() {
        let metadata = target
            .metadata()
            .map_err(|e| format!("target metadata failed: {e}"))?;
        if !metadata.is_file() {
            return Err("target path must be a file".to_string());
        }
        let resolved = target
            .canonicalize()
            .map_err(|e| format!("canonicalize target failed: {e}"))?;
        validate_allowed_resolved_path(app, &resolved)?;
    }
    Ok(target)
}

fn validate_allowed_directory_path(
    app: &tauri::AppHandle,
    path: &str,
) -> Result<std::path::PathBuf, String> {
    let path = std::path::PathBuf::from(path);
    if !path.is_absolute() {
        return Err("path must be absolute".to_string());
    }
    let resolved = path
        .canonicalize()
        .map_err(|e| format!("canonicalize directory failed: {e}"))?;
    if !resolved.is_dir() {
        return Err("path must be a directory".to_string());
    }
    validate_allowed_resolved_path(app, &resolved)?;
    Ok(resolved)
}

fn validate_allowed_resolved_path(
    app: &tauri::AppHandle,
    path: &std::path::Path,
) -> Result<(), String> {
    use tauri_plugin_fs::FsExt;

    if !app.fs_scope().is_allowed(path) {
        return Err("path is outside allowed Tauri file scope".to_string());
    }
    Ok(())
}

fn validate_pdf_file_name(path: &std::path::Path) -> Result<(), String> {
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
    {
        Ok(())
    } else {
        Err("path must be a PDF file".to_string())
    }
}

fn validate_pdf_temp_path(path: &std::path::Path) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "temp path has invalid file name".to_string())?;
    if !name.contains(".pecotool-") || !name.ends_with(".tmp") {
        return Err("path is not a pecotool temp file".to_string());
    }
    Ok(())
}

fn temp_target_path(temp: &std::path::Path) -> Result<std::path::PathBuf, String> {
    validate_pdf_temp_path(temp)?;
    let temp_name = temp
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "temp path has invalid file name".to_string())?;
    let marker = temp_name
        .rfind(".pecotool-")
        .ok_or_else(|| "path is not a pecotool temp file".to_string())?;
    let target_name = &temp_name[..marker];
    if target_name.is_empty() {
        return Err("temp path has empty target file name".to_string());
    }
    let parent = temp
        .parent()
        .ok_or_else(|| "temp path has no parent directory".to_string())?;
    Ok(parent.join(target_name))
}

fn validate_pdf_temp_target(
    temp: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    validate_pdf_temp_path(temp)?;
    if temp.parent() != target.parent() {
        return Err("temp file must be in the target directory".to_string());
    }

    let target_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "target path has invalid file name".to_string())?;
    let temp_name = temp
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "temp path has invalid file name".to_string())?;
    if !temp_name.starts_with(&format!("{target_name}.pecotool-")) {
        return Err("temp file does not match target file".to_string());
    }

    Ok(())
}

fn parse_pdf_chunk_offset(headers: &tauri::http::HeaderMap) -> Result<u64, String> {
    let offset_raw = headers
        .get("x-offset")
        .ok_or_else(|| "missing x-offset header".to_string())?;
    let offset = offset_raw
        .to_str()
        .map_err(|_| "invalid x-offset header".to_string())?;
    offset
        .parse()
        .map_err(|_| "invalid x-offset header".to_string())
}

fn validate_pdf_chunk_offset_contiguous(current_len: u64, offset: u64) -> Result<(), String> {
    if current_len != offset {
        return Err(format!(
            "chunk offset mismatch: expected {}, got {}",
            current_len, offset
        ));
    }
    Ok(())
}

/// `x-path` header は percent-encoded で受け取るため簡易デコード。
fn percent_decode(s: &str) -> String {
    let mut out = Vec::with_capacity(s.len());
    let mut chars = s.as_bytes().iter().copied().peekable();
    while let Some(c) = chars.next() {
        if c == b'%' {
            let hi = chars.next().and_then(|c| hex_value(c));
            let lo = chars.next().and_then(|c| hex_value(c));
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push(h * 16 + l);
                continue;
            }
        }
        out.push(c);
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_value(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::http::{HeaderMap, HeaderValue};

    // ── run_ocr byte-path (#285) ──────────────────────────────────

    #[test]
    fn write_ocr_temp_bytes_creates_and_can_be_removed() {
        let data = b"fake png data for test";
        let path = write_ocr_temp_bytes(data).expect("write_ocr_temp_bytes should succeed");

        // ファイルが作成されていること
        assert!(path.exists(), "temp file must exist after write");

        // 内容が一致すること
        let read_back = std::fs::read(&path).expect("read back should succeed");
        assert_eq!(read_back, data);

        // クリーンアップできること
        std::fs::remove_file(&path).expect("cleanup should succeed");
        assert!(!path.exists(), "temp file must be removed after cleanup");
    }

    #[test]
    fn write_ocr_temp_bytes_path_is_not_unc_verbatim() {
        let data = b"\x89PNG\r\n\x1a\n"; // minimal PNG header bytes
        let path = write_ocr_temp_bytes(data).expect("write should succeed");
        let path_str = path.to_string_lossy();

        // std::env::temp_dir() + join は UNC verbatim prefix を付けない
        // (canonicalize() を呼ばないので \\?\ にならない)
        assert!(
            !path_str.starts_with(r"\\?\"),
            "temp path must not have UNC verbatim prefix, got: {path_str}"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn write_ocr_temp_bytes_two_calls_produce_different_paths() {
        let data1 = b"payload_one";
        let data2 = b"payload_two";
        let p1 = write_ocr_temp_bytes(data1).expect("first write");
        let p2 = write_ocr_temp_bytes(data2).expect("second write");
        // nanos + atomic counter により別 bytes でも同 bytes でも衝突しない
        assert_ne!(p1, p2, "each call must produce a unique path");
        let _ = std::fs::remove_file(&p1);
        let _ = std::fs::remove_file(&p2);
    }

    // ── regression: #289 unique temp file naming ──────────────────────────

    #[test]
    fn write_ocr_temp_bytes_100_sequential_all_unique() {
        let data = b"same bytes for every call";
        let mut paths = Vec::with_capacity(100);
        for _ in 0..100 {
            let p = write_ocr_temp_bytes(data).expect("write should succeed");
            paths.push(p);
        }
        // 全パスがユニークであること
        let unique: std::collections::HashSet<_> = paths.iter().collect();
        assert_eq!(unique.len(), 100, "all 100 paths must be distinct");
        for p in &paths {
            let _ = std::fs::remove_file(p);
        }
    }

    #[test]
    fn write_ocr_temp_bytes_same_bytes_twice_produce_different_paths() {
        // 同一 bytes スライス（同 ptr）を 2 回渡しても別 path を返すこと
        let data = b"identical payload";
        let p1 = write_ocr_temp_bytes(data).expect("first write");
        let p2 = write_ocr_temp_bytes(data).expect("second write");
        assert_ne!(
            p1, p2,
            "same bytes must not collide: nanos+counter must differ"
        );
        let _ = std::fs::remove_file(&p1);
        let _ = std::fs::remove_file(&p2);
    }

    #[test]
    fn extract_ttc_face_rejects_zero_tables() {
        let mut ttc = Vec::new();
        ttc.extend_from_slice(b"ttcf");
        ttc.extend_from_slice(&0x0001_0000u32.to_be_bytes());
        ttc.extend_from_slice(&1u32.to_be_bytes());
        ttc.extend_from_slice(&16u32.to_be_bytes());
        ttc.extend_from_slice(&0x0001_0000u32.to_be_bytes());
        ttc.extend_from_slice(&0u16.to_be_bytes());

        let err = extract_ttc_face(&ttc, 0).unwrap_err();
        assert!(err.contains("no tables"));
    }

    #[test]
    fn parse_pdf_chunk_offset_requires_valid_header() {
        let headers = HeaderMap::new();
        assert_eq!(
            parse_pdf_chunk_offset(&headers).unwrap_err(),
            "missing x-offset header"
        );

        let mut headers = HeaderMap::new();
        headers.insert("x-offset", HeaderValue::from_static("not-a-number"));
        assert_eq!(
            parse_pdf_chunk_offset(&headers).unwrap_err(),
            "invalid x-offset header"
        );

        let mut headers = HeaderMap::new();
        headers.insert("x-offset", HeaderValue::from_static("42"));
        assert_eq!(parse_pdf_chunk_offset(&headers).unwrap(), 42);
    }

    #[test]
    fn validate_pdf_file_name_requires_pdf_extension() {
        assert!(validate_pdf_file_name(std::path::Path::new("sample.PDF")).is_ok());
        assert_eq!(
            validate_pdf_file_name(std::path::Path::new("sample.pdf.tmp")).unwrap_err(),
            "path must be a PDF file"
        );
    }

    #[test]
    fn validate_pdf_chunk_offset_contiguous_rejects_gaps() {
        assert!(validate_pdf_chunk_offset_contiguous(8, 8).is_ok());
        assert_eq!(
            validate_pdf_chunk_offset_contiguous(8, 12).unwrap_err(),
            "chunk offset mismatch: expected 8, got 12"
        );
    }

    // ── estimate_confidence heuristic (#287) ─────────────────────────────

    #[test]
    fn estimate_confidence_empty_text_returns_low() {
        let c = estimate_confidence("", 100.0, 20.0);
        assert!((c - 0.3).abs() < f64::EPSILON, "empty text must return 0.3, got {c}");
    }

    #[test]
    fn estimate_confidence_single_char_returns_mid() {
        let c = estimate_confidence("A", 20.0, 20.0);
        assert!((c - 0.5).abs() < f64::EPSILON, "single char must return 0.5, got {c}");
    }

    #[test]
    fn estimate_confidence_high_symbol_ratio_returns_mid() {
        // "!!!" -> 3 symbols / 3 chars = 1.0 ratio > 0.5
        let c = estimate_confidence("!!!", 30.0, 20.0);
        assert!((c - 0.5).abs() < f64::EPSILON, "symbol-heavy text must return 0.5, got {c}");
    }

    #[test]
    fn estimate_confidence_normal_text_returns_high() {
        let c = estimate_confidence("通常のテキスト", 200.0, 20.0);
        assert!((c - 0.9).abs() < f64::EPSILON, "normal text must return 0.9, got {c}");
    }

    #[test]
    fn estimate_confidence_extreme_aspect_wide_returns_mid() {
        // aspect = 420.0 / 20.0 = 21.0 > 20.0
        let c = estimate_confidence("normal text here", 420.0, 20.0);
        assert!((c - 0.5).abs() < f64::EPSILON, "extremely wide box must return 0.5, got {c}");
    }

    #[test]
    fn estimate_confidence_extreme_aspect_narrow_returns_mid() {
        // aspect = 1.0 / 100.0 = 0.01 < 0.05
        let c = estimate_confidence("normal text here", 1.0, 100.0);
        assert!((c - 0.5).abs() < f64::EPSILON, "extremely narrow box must return 0.5, got {c}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_meiryo_font,
            list_ocr_languages,
            run_ocr,
            get_pdf_page_dimensions,
            list_pdf_files_in_folder,
            write_perf_log,
            write_operation_log,
            write_audit_log,
            open_log_folder,
            write_pdf_chunk,
            replace_pdf_file,
            backup::save_backup,
            backup::check_pending_backups,
            backup::clear_backup,
            backup::load_backup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
