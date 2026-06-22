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

/// Scan `dir` and return an alphabetically sorted list of PDF file paths.
///
/// Only direct children that are files with a `.pdf` extension (case-insensitive)
/// are returned.  Sub-directories are skipped.  This is the AppHandle-free core
/// extracted from `list_pdf_files_in_folder` so it can be unit-tested without
/// Tauri infrastructure.
fn list_pdf_files(dir: &std::path::Path) -> Result<Vec<String>, String> {
    use std::fs;

    let mut paths = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| format!("read_dir failed: {e}"))? {
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
}

#[tauri::command]
async fn list_pdf_files_in_folder(
    app: tauri::AppHandle,
    folder_path: String,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
        let folder = validate_allowed_directory_path(&app, &folder_path)?;
        list_pdf_files(&folder)
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
///
/// PCT-101: image bytes は IPC raw body として受け取る（JSON 経由では
/// Uint8Array→number[] の変換で 2MB PNG が約 16MB ヒープを消費するため）。
/// 数値メタは HTTP-like headers で渡す:
///   x-page-width    : f64 (文字列)
///   x-page-height   : f64 (文字列, 現状未使用)
///   x-render-scale  : f64 (文字列)
///   x-language-tag  : OCR 言語タグ (省略時 "ja")
#[tauri::command]
async fn run_ocr(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let headers = request.headers();

    // M1 (PCT-101): parse_run_ocr_headers でヘッダー欠落・パース失敗を明示エラーにする。
    // 旧来の unwrap_or(1.0) による黙示 fallback は「OCR が完走して座標だけズレる」
    // 最悪の壊れ方を引き起こすため、write_pdf_chunk のエラー方針に揃えた。
    let ocr_headers = parse_run_ocr_headers(headers)?;
    let render_scale = ocr_headers.render_scale;
    let language_tag = ocr_headers.language_tag;
    // x-page-height は現状未使用だが、以前と同様 headers から読めることを確保する。
    let _page_height: f64 = headers
        .get("x-page-height")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);
    let _ = (ocr_headers.page_width, _page_height); // 座標変換は render_scale のみ使用

    let image_bytes: Vec<u8> = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        _ => return Err("[run_ocr] expected raw body".to_string()),
    };

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

/// PCT-116: temp 直書きの上限サイズ。raw IPC body をそのまま書くため、Webview 侵害時に
/// 巨大 body の連投で temp ディスクを圧迫されないよう上限を設ける。業務 PDF / OCR 画像の
/// 現実的上限を踏まえ 500MB とする（正規 UI の経路では到達しない）。
const MAX_TEMP_WRITE_BYTES: usize = 500 * 1024 * 1024;

/// PCT-116: 起動時に前回セッションが残した OCR/プレビュー temp ファイルを掃除する。
/// `open_pdf_preview` の一時 PDF は外部ビューアで開く性質上その場で削除できず残置するため、
/// 起動時に自分が書く prefix のファイルのみを対象に削除する。開いている最中のファイルは
/// 削除に失敗しうるが無視する（次回起動で消える）。
fn cleanup_stale_ocr_temp_files() {
    let temp_dir = std::env::temp_dir();
    let Ok(entries) = std::fs::read_dir(&temp_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("peco_ocr_preview_") || name.starts_with("peco_ocr_") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Write image bytes to a uniquely-named temp PNG and return its path.
/// Uses `std::env::temp_dir()` directly, bypassing Tauri fs-scope checks.
/// Uniqueness is guaranteed by combining PID, nanosecond timestamp, and a
/// per-process monotonic counter — preventing collisions even when the same
/// bytes (and therefore the same pointer) are written in rapid succession.
pub(crate) fn write_ocr_temp_bytes(bytes: &[u8]) -> Result<std::path::PathBuf, String> {
    // PCT-116: temp 直書きのサイズ上限ガード。
    if bytes.len() > MAX_TEMP_WRITE_BYTES {
        return Err(format!(
            "temp write rejected: {} bytes exceeds limit {}",
            bytes.len(),
            MAX_TEMP_WRITE_BYTES
        ));
    }
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

/// OCR 位置補正の calibration 用プレビュー: PDF bytes を `temp_dir()` へ一意名で直書きし、
/// 既定の PDF ビューアで開く。
///
/// `temp_dir()` 直書きにより Tauri fs スコープ検証を回避する（#285: Windows の
/// `\\?\`-prefix 正規化で $TEMP がスコープ glob にマッチせず `is_allowed` が false に
/// なるため、JS 側 writeFileAtomically/opener 経由では開けない）。表示も Rust の
/// `app.opener()` で行い opener スコープ検証も回避する。毎回一意名なのでビューアの
/// ファイルキャッシュに当たらず、数値変更 → プレビューの反復ができる。
///
/// フロントは PDF bytes を raw IPC body で渡す。返り値は書き出した一時パス。
#[tauri::command]
async fn open_pdf_preview(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;

    let bytes: Vec<u8> = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        _ => return Err("[open_pdf_preview] expected raw body".to_string()),
    };

    // PCT-116: temp 直書きのサイズ上限ガード。
    if bytes.len() > MAX_TEMP_WRITE_BYTES {
        return Err(format!(
            "[open_pdf_preview] body {} bytes exceeds limit {}",
            bytes.len(),
            MAX_TEMP_WRITE_BYTES
        ));
    }

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let counter = OCR_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "peco_ocr_preview_{}_{}_{}.pdf",
        std::process::id(),
        nanos,
        counter,
    ));
    std::fs::write(&path, &bytes).map_err(|e| format!("preview write failed: {}", e))?;

    let path_str = path.to_string_lossy().to_string();
    app.opener()
        .open_path(path_str.clone(), None::<&str>)
        .map_err(|e| format!("open_path failed: {}", e))?;
    Ok(path_str)
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

    // PCT-079: render_scale は bbox 座標変換の除算分母に使うため、0 以下・非有限値を
    // COM 初期化前に拒否する（正規 UI からは到達しないが防御的に検証）。
    if !render_scale.is_finite() || render_scale <= 0.0 {
        return Err(format!(
            "render_scaleが不正です (0より大きい有限値が必要): {render_scale}"
        ));
    }

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
        // PCT-113: temp 名は UUID を含み毎回変わるため、ホワイトリスト照合は対応する
        // 最終 PDF 名 (target) に対して行う。temp_target_path は path が正規の
        // `.pecotool-...tmp` 形式であることも検証する。
        let target = temp_target_path(&path)?;
        validate_pdf_file_name(&target)?;
        // ホワイトリスト照合は最終 PDF 名 (target) に対して行う。保存ダイアログが
        // fs scope に追加するのはユーザーが選んだ target (.pdf) のみで、temp 自身
        // (`<target>.pecotool-<uuid>.tmp`) はファイル単位照合の scope には入らない。
        // PCT-113 で temp 側にも is_allowed を掛けたところ、正規の保存先でも temp が
        // scope 外と判定され保存が全面的に失敗した (PCT-118)。temp は temp_target_path /
        // validate_pdf_temp_path により「scope 検証済み target と同一ディレクトリの兄弟」で
        // あることが保証されるため、target の検証で書込先の妥当性は担保される。
        validate_allowed_resolved_path(&app, &target)?;

        write_chunk_at(&path, offset, &bytes)
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {}", e))?
}

/// Write `bytes` at `offset` in the file at `path`.
///
/// This is the AppHandle-free core extracted from `write_pdf_chunk` so it can be
/// unit-tested without Tauri infrastructure.
///
/// - `offset == 0`: create-or-truncate the file, then write from the beginning.
/// - `offset > 0`: open the existing file, validate contiguity, seek, then write.
///
/// All error messages mirror those produced by `write_pdf_chunk` so the external
/// behaviour of the command is unchanged.
fn write_chunk_at(path: &std::path::Path, offset: u64, bytes: &[u8]) -> Result<(), String> {
    use std::fs::OpenOptions;
    use std::io::{Seek, SeekFrom, Write};

    let mut opts = OpenOptions::new();
    opts.write(true);
    if offset == 0 {
        opts.create(true).truncate(true);
    } else {
        opts.create(false).truncate(false);
    }
    let mut f = opts
        .open(path)
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
    f.write_all(bytes)
        .map_err(|e| format!("write failed: {}", e))?;
    Ok(())
}

/// チャンク書き込み済みの一時 PDF を正式ファイルへ置き換える。
///
/// PCT-077: 旧実装は「Windows では rename が既存ファイルを上書きできない」という
/// 誤った前提で「① target→backup 退避 → ② temp→target」の2段階 rename を行っており、
/// ①と②の間でプロセス強制終了・電源断が起きると target のファイル名が消失する窓が
/// あった。実際には `std::fs::rename` は Windows でも
/// `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` を使うため、既存ファイルを単一の
/// アトミック操作で置き換えられる（テスト `std_fs_rename_overwrites_existing_target`
/// で実測確認済み）。backup 退避を廃止した単一 rename 方式により、どの時点で
/// クラッシュしても target 名は常に旧内容か新内容のどちらか完全な方を指す。
///
/// PCT-078: `write_pdf_chunk` (write_chunk_at) は性能上チャンク毎の fsync を
/// 行わないため、rename 直前にここで一度だけ temp を sync し、rename 直後の
/// 電源断で不完全な内容が target に昇格することを防ぐ。
#[tauri::command]
async fn replace_pdf_file(
    app: tauri::AppHandle,
    temp_path: String,
    target_path: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        use std::fs;

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

        replace_target_with_temp(&temp, &target)
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {}", e))?
}

/// temp を target へ単一 rename で移動する（target 既存なら上書き）。
/// rename 前に temp を fsync し、書き込み済みチャンクを物理ディスクへ確定させる
/// (PCT-078)。
///
/// この関数は `AppHandle` に依存せず、テスト可能な純粋なファイル操作のみを行う。
fn replace_target_with_temp(
    temp: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    sync_file_to_disk(temp)?;
    replace_target_with_temp_inner(temp, target, |src, dst| std::fs::rename(src, dst))
}

/// PCT-078: rename 直前に呼び、ファイル内容を OS バッファからディスクへ flush する。
/// Windows の FlushFileBuffers は書き込みアクセス権を要求するため write モードで
/// 開く（truncate しないので内容は不変）。
fn sync_file_to_disk(path: &std::path::Path) -> Result<(), String> {
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|e| format!("open for sync failed: {e} ({})", path.to_string_lossy()))?;
    file.sync_all()
        .map_err(|e| format!("sync_all failed: {e} ({})", path.to_string_lossy()))?;
    Ok(())
}

/// rename 操作を注入可能にした内部実装。テストで失敗注入に使う。
///
/// PCT-077: target の既存有無によらず `rename_fn(temp, target)` を1回だけ実行する
/// （`std::fs::rename` は Windows でも既存 target をアトミックに置き換える）。
/// 旧実装の backup 退避（2段階 rename）は廃止: クラッシュ時に target 名が消失する
/// 窓と backup ファイル残留の両方を除去した。rename が失敗した場合は target に
/// 一切触れていないため「target 無傷・temp 残存」が成立する（temp はユーザー
/// データ救済のため削除しない）。
fn replace_target_with_temp_inner(
    temp: &std::path::Path,
    target: &std::path::Path,
    rename_fn: impl Fn(&std::path::Path, &std::path::Path) -> std::io::Result<()>,
) -> Result<(), String> {
    rename_fn(temp, target).map_err(|e| {
        format!(
            "rename temp->target failed: {e}; temp file kept at: {}",
            temp.to_string_lossy()
        )
    })
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
    // 不変条件 (PCT-118 の安全性根拠): target_name は temp.file_name() の接頭辞であり、
    // file_name() は常にパスの最終成分（セパレータを含まない単一成分）を返す。よって
    // target_name にパス区切りが混入する経路は存在せず、parent.join は temp と同一
    // ディレクトリ内の名前にしかならない。これにより target は temp の兄弟であることが
    // 保証され、validate_allowed_resolved_path(target) の scope 検証が書込先を担保する。
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

/// M1 (PCT-101): run_ocr の headers から数値メタを解析する。
/// 欠落・パース失敗は Err を返す（unwrap_or による黙示 fallback を禁止）。
/// x-render-scale 欠落→1.0 続行は「OCR が完走して座標だけズレる」最悪の壊れ方のため、
/// write_pdf_chunk のエラー方針（欠落/パース失敗は Err）に揃える。
#[derive(Debug)]
struct RunOcrHeaders {
    page_width: f64,
    render_scale: f64,
    language_tag: Option<String>,
}

fn parse_run_ocr_headers(headers: &tauri::http::HeaderMap) -> Result<RunOcrHeaders, String> {
    let page_width: f64 = headers
        .get("x-page-width")
        .ok_or_else(|| "missing x-page-width header".to_string())?
        .to_str()
        .map_err(|_| "invalid x-page-width header".to_string())?
        .parse()
        .map_err(|_| "invalid x-page-width header".to_string())?;

    let render_scale: f64 = headers
        .get("x-render-scale")
        .ok_or_else(|| "missing x-render-scale header".to_string())?
        .to_str()
        .map_err(|_| "invalid x-render-scale header".to_string())?
        .parse()
        .map_err(|_| "invalid x-render-scale header".to_string())?;

    let language_tag: Option<String> = headers
        .get("x-language-tag")
        .and_then(|h| h.to_str().ok())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    Ok(RunOcrHeaders { page_width, render_scale, language_tag })
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

    // ── PCT-118: temp/target 導出と path 検証の回帰 ──────────────────

    #[test]
    fn temp_target_path_strips_pecotool_suffix() {
        let temp = std::path::Path::new(r"C:\docs\report.pdf.pecotool-abc123.tmp");
        let target = temp_target_path(temp).expect("valid temp must derive target");
        assert_eq!(target, std::path::Path::new(r"C:\docs\report.pdf"));
    }

    #[test]
    fn temp_target_path_keeps_target_in_same_directory() {
        // PCT-118 の安全性根拠: target は temp と必ず同一ディレクトリの兄弟になる
        let temp = std::path::Path::new(r"C:\a\b\file.pdf.pecotool-x.tmp");
        let target = temp_target_path(temp).expect("valid temp");
        assert_eq!(temp.parent(), target.parent());
    }

    #[test]
    fn temp_target_path_rejects_empty_target_name() {
        let temp = std::path::Path::new(r"C:\docs\.pecotool-x.tmp");
        let err = temp_target_path(temp).unwrap_err();
        assert!(err.contains("empty target file name"), "got: {err}");
    }

    #[test]
    fn temp_target_path_target_name_never_contains_separator() {
        // 不変条件: 親に .. を含む temp でも target_name は file_name 由来の単一成分なので
        // セパレータを含まず、target は temp と同じ parent を持つ（別ディレクトリへ逃げない）。
        let temp = std::path::Path::new(r"C:\docs\evil\..\x.pdf.pecotool-y.tmp");
        let target = temp_target_path(temp).expect("valid temp");
        let target_name = target.file_name().and_then(|n| n.to_str()).unwrap();
        assert_eq!(target_name, "x.pdf");
        assert!(!target_name.contains('/') && !target_name.contains('\\'));
        assert_eq!(temp.parent(), target.parent());
    }

    #[test]
    fn validate_pdf_temp_path_rejects_non_pecotool_name() {
        let err = validate_pdf_temp_path(std::path::Path::new(r"C:\docs\plain.pdf")).unwrap_err();
        assert!(err.contains("not a pecotool temp file"), "got: {err}");
    }

    #[test]
    fn validate_pdf_temp_path_rejects_missing_tmp_suffix() {
        let err =
            validate_pdf_temp_path(std::path::Path::new(r"C:\docs\x.pdf.pecotool-abc")).unwrap_err();
        assert!(err.contains("not a pecotool temp file"), "got: {err}");
    }

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

    // ── replace_target_with_temp_inner atomic-replace tests ──────────────

    use std::sync::atomic::{AtomicU64, Ordering};

    /// テスト用の一意な作業ディレクトリを作成する。
    /// tempfile クレートを増やさないため process::id() + AtomicU64 カウンタで衝突回避する。
    fn make_replace_test_dir(tag: &str) -> std::path::PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "pecotool_replace_test_{}_{}_{}", std::process::id(), tag, n
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("test dir creation failed");
        dir
    }

    /// PCT-077 検証: `std::fs::rename(temp, target)` は target が既存でも
    /// (a) Err にならない (b) target の内容が temp のものになる (c) temp が消える。
    ///
    /// Windows の `std::fs::rename` は内部で
    /// `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` を使うため、既存ファイルを
    /// 単一のアトミック操作で置き換えられる。この性質が
    /// `replace_target_with_temp_inner` の単一 rename 方式の前提なので、
    /// プラットフォーム回帰検知としてテストで固定する。
    #[test]
    fn std_fs_rename_overwrites_existing_target() {
        let dir = make_replace_test_dir("rename_verify");
        let temp = dir.join("verify.pdf.pecotool-1.tmp");
        let target = dir.join("verify.pdf");

        std::fs::write(&temp, b"temp content").unwrap();
        std::fs::write(&target, b"old target content").unwrap();

        let result = std::fs::rename(&temp, &target);

        assert!(
            result.is_ok(),
            "rename over existing target must succeed, got: {:?}",
            result.err()
        );
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"temp content",
            "target must contain temp's content after rename"
        );
        assert!(!temp.exists(), "temp must be gone after rename");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (a) target が存在しない場合: temp の内容が target に移動される。
    #[test]
    fn replace_inner_no_existing_target_moves_temp_to_target() {
        let dir = make_replace_test_dir("a");
        let temp = dir.join("sample.pdf.pecotool-12345.tmp");
        let target = dir.join("sample.pdf");

        std::fs::write(&temp, b"new content").unwrap();

        replace_target_with_temp_inner(&temp, &target, |src, dst| std::fs::rename(src, dst)).unwrap();

        assert!(target.exists(), "target must exist after replace");
        assert!(!temp.exists(), "temp must be gone after replace");
        assert_eq!(std::fs::read(&target).unwrap(), b"new content");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (b) target が存在する場合: 単一 rename で target が新内容になり、
    /// backup ファイル等の残骸が一切作られない (PCT-077)。
    #[test]
    fn replace_inner_existing_target_replaced_without_residue() {
        let dir = make_replace_test_dir("b");
        let temp = dir.join("doc.pdf.pecotool-99999.tmp");
        let target = dir.join("doc.pdf");

        std::fs::write(&temp, b"new version").unwrap();
        std::fs::write(&target, b"old version").unwrap();

        replace_target_with_temp_inner(&temp, &target, |src, dst| std::fs::rename(src, dst)).unwrap();

        assert!(target.exists(), "target must exist after replace");
        assert!(!temp.exists(), "temp must be gone after replace");
        assert_eq!(std::fs::read(&target).unwrap(), b"new version");

        // ディレクトリには target 1つだけが残る（backup 残骸ゼロ）
        let entries: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            entries,
            vec!["doc.pdf".to_string()],
            "no residue files must remain after replace"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (c) rename が失敗した場合: target は無傷（元の内容のまま）で temp が残存する。
    /// これが最重要: データ損失耐性の中核保証 (PCT-077)。
    /// 単一 rename は失敗しても target に触れないため、旧実装のような復元処理は不要。
    #[test]
    fn replace_inner_rename_failure_leaves_target_intact_and_temp_present() {
        let dir = make_replace_test_dir("c");
        let temp = dir.join("restore.pdf.pecotool-77777.tmp");
        let target = dir.join("restore.pdf");

        std::fs::write(&temp, b"new content").unwrap();
        std::fs::write(&target, b"original content").unwrap();

        let fail_rename = |_src: &std::path::Path, _dst: &std::path::Path| -> std::io::Result<()> {
            Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "injected failure"))
        };

        let err = replace_target_with_temp_inner(&temp, &target, fail_rename).unwrap_err();

        assert!(
            err.contains("rename temp->target failed"),
            "error must mention the failed rename, got: {err}"
        );
        // target が元の内容のまま無傷であること
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"original content",
            "target must be untouched after rename failure"
        );
        // temp はデータ救済のため残存していること
        assert_eq!(
            std::fs::read(&temp).unwrap(),
            b"new content",
            "temp must remain for data recovery after rename failure"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── write_chunk_at: AppHandle-free core of write_pdf_chunk ──────────

    /// (a) offset==0 で新規ファイルが作成され、内容が一致すること。
    #[test]
    fn write_chunk_at_creates_new_file_on_offset_zero() {
        let dir = make_replace_test_dir("chunk_a");
        let path = dir.join("new.pdf.pecotool-1.tmp");

        write_chunk_at(&path, 0, b"hello chunk").unwrap();

        assert!(path.exists(), "file must be created");
        assert_eq!(std::fs::read(&path).unwrap(), b"hello chunk");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (b) offset==0 は既存ファイルを truncate して上書きする（残骸が残らない）。
    #[test]
    fn write_chunk_at_truncates_existing_file_on_offset_zero() {
        let dir = make_replace_test_dir("chunk_b");
        let path = dir.join("existing.pdf.pecotool-2.tmp");

        // longer old content
        std::fs::write(&path, b"old long content here").unwrap();

        write_chunk_at(&path, 0, b"new").unwrap();

        let content = std::fs::read(&path).unwrap();
        assert_eq!(content, b"new", "only the new content must remain; old residue must be gone");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (c) 複数チャンク (offset=0, then offset=len) で連結結果が元バイト列と一致すること。
    #[test]
    fn write_chunk_at_multi_chunk_concatenates_correctly() {
        let dir = make_replace_test_dir("chunk_c");
        let path = dir.join("multi.pdf.pecotool-3.tmp");

        let part1 = b"first chunk ";
        let part2 = b"second chunk";

        write_chunk_at(&path, 0, part1).unwrap();
        write_chunk_at(&path, part1.len() as u64, part2).unwrap();

        let content = std::fs::read(&path).unwrap();
        let expected: Vec<u8> = part1.iter().chain(part2.iter()).copied().collect();
        assert_eq!(content, expected, "multi-chunk write must concatenate correctly");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (d) offset が現在長と不連続ならエラー（ギャップ拒否）。
    #[test]
    fn write_chunk_at_rejects_non_contiguous_offset() {
        let dir = make_replace_test_dir("chunk_d");
        let path = dir.join("gap.pdf.pecotool-4.tmp");

        std::fs::write(&path, b"12345678").unwrap(); // len = 8

        // offset 12 は現在長 8 と一致しないのでエラー
        let err = write_chunk_at(&path, 12, b"oops").unwrap_err();
        assert!(
            err.contains("chunk offset mismatch"),
            "expected contiguity error, got: {err}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (e) 空 bytes (byteLength 0) + offset==0 で空ファイルが作られること。
    #[test]
    fn write_chunk_at_empty_bytes_creates_empty_file() {
        let dir = make_replace_test_dir("chunk_e");
        let path = dir.join("empty.pdf.pecotool-5.tmp");

        write_chunk_at(&path, 0, b"").unwrap();

        assert!(path.exists(), "empty file must be created");
        assert_eq!(std::fs::read(&path).unwrap(), b"", "file must be empty");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── list_pdf_files: AppHandle-free core of list_pdf_files_in_folder ──

    /// .pdf のみ返る（大文字 .PDF も拾う）。
    #[test]
    fn list_pdf_files_returns_only_pdf_files() {
        let dir = make_replace_test_dir("list_a");
        std::fs::write(dir.join("a.pdf"), b"").unwrap();
        std::fs::write(dir.join("B.PDF"), b"").unwrap();
        std::fs::write(dir.join("c.txt"), b"").unwrap();
        std::fs::write(dir.join("d.docx"), b"").unwrap();

        let result = list_pdf_files(&dir).unwrap();

        // 名前でソートされた状態でチェック
        let names: Vec<&str> = result
            .iter()
            .map(|p| std::path::Path::new(p).file_name().and_then(|n| n.to_str()).unwrap_or(""))
            .collect();
        assert!(names.contains(&"a.pdf"), "a.pdf must be included");
        assert!(names.contains(&"B.PDF"), "B.PDF (uppercase) must be included");
        assert!(!names.contains(&"c.txt"), "c.txt must be excluded");
        assert!(!names.contains(&"d.docx"), "d.docx must be excluded");
        assert_eq!(result.len(), 2, "exactly 2 PDF files expected");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 非 PDF ファイルは除外される。
    #[test]
    fn list_pdf_files_excludes_non_pdf() {
        let dir = make_replace_test_dir("list_b");
        std::fs::write(dir.join("report.txt"), b"").unwrap();
        std::fs::write(dir.join("image.png"), b"").unwrap();

        let result = list_pdf_files(&dir).unwrap();
        assert!(result.is_empty(), "no PDFs: result must be empty, got: {:?}", result);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 空ディレクトリで空リストが返る。
    #[test]
    fn list_pdf_files_empty_dir_returns_empty_vec() {
        let dir = make_replace_test_dir("list_c");

        let result = list_pdf_files(&dir).unwrap();
        assert!(result.is_empty(), "empty dir must return empty vec");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 結果がアルファベット順（文字列ソート）で返ること。
    #[test]
    fn list_pdf_files_result_is_sorted() {
        let dir = make_replace_test_dir("list_d");
        std::fs::write(dir.join("c.pdf"), b"").unwrap();
        std::fs::write(dir.join("a.pdf"), b"").unwrap();
        std::fs::write(dir.join("b.pdf"), b"").unwrap();

        let result = list_pdf_files(&dir).unwrap();
        assert_eq!(result.len(), 3);

        let mut sorted = result.clone();
        sorted.sort();
        assert_eq!(result, sorted, "list_pdf_files must return sorted paths");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (d) rename 失敗時のエラーメッセージに temp パスが含まれ、
    /// 手動復旧（残存 temp からのデータ救済）に必要な情報が欠落しないこと (PCT-077)。
    #[test]
    fn replace_inner_rename_failure_error_contains_temp_path() {
        let dir = make_replace_test_dir("d");
        let temp = dir.join("critical.pdf.pecotool-55555.tmp");
        let target = dir.join("critical.pdf");

        std::fs::write(&temp, b"new data").unwrap();
        std::fs::write(&target, b"original data").unwrap();

        let fail_rename = |_src: &std::path::Path, _dst: &std::path::Path| -> std::io::Result<()> {
            Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "injected failure"))
        };

        let err = replace_target_with_temp_inner(&temp, &target, fail_rename).unwrap_err();

        let temp_str = temp.to_string_lossy();
        assert!(
            err.contains(temp_str.as_ref()),
            "error must contain temp path so operator can recover manually, got: {err}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── sync_file_to_disk (PCT-078) ──────────────────────────────────────

    /// 既存ファイルへの sync は成功し、内容を変更しない。
    #[test]
    fn sync_file_to_disk_succeeds_and_preserves_content() {
        let dir = make_replace_test_dir("sync_a");
        let path = dir.join("data.pdf.pecotool-1.tmp");
        std::fs::write(&path, b"chunk data").unwrap();

        sync_file_to_disk(&path).unwrap();

        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"chunk data",
            "sync must not alter file content"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 存在しないファイルへの sync は open 失敗エラーを返す。
    #[test]
    fn sync_file_to_disk_missing_file_returns_error() {
        let dir = make_replace_test_dir("sync_b");
        let path = dir.join("missing.pdf.pecotool-2.tmp");

        let err = sync_file_to_disk(&path).unwrap_err();
        assert!(
            err.contains("open for sync failed"),
            "expected open error, got: {err}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// replace_target_with_temp（実運用経路）は sync + 単一 rename で
    /// 既存 target を新内容に置き換える。sync が経路に含まれることは
    /// 関数本体（sync_file_to_disk → inner）で構造的に保証されるため、
    /// ここでは経路全体が実ファイルで成功することを固定する (PCT-078)。
    #[test]
    fn replace_target_with_temp_full_path_replaces_existing_target() {
        let dir = make_replace_test_dir("sync_c");
        let temp = dir.join("full.pdf.pecotool-3.tmp");
        let target = dir.join("full.pdf");
        std::fs::write(&temp, b"synced new content").unwrap();
        std::fs::write(&target, b"old content").unwrap();

        replace_target_with_temp(&temp, &target).unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"synced new content");
        assert!(!temp.exists(), "temp must be gone after replace");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── do_windows_ocr render_scale guard (PCT-079) ──────────────────────

    /// render_scale == 0 は COM 初期化・ファイルアクセス前に拒否される（ゼロ除算防止）。
    #[test]
    fn do_windows_ocr_rejects_zero_render_scale() {
        let err = do_windows_ocr("unused.png", 0.0, "ja").unwrap_err();
        assert!(
            err.contains("render_scale"),
            "error must mention render_scale, got: {err}"
        );
    }

    /// 負の render_scale も拒否される。
    #[test]
    fn do_windows_ocr_rejects_negative_render_scale() {
        let err = do_windows_ocr("unused.png", -1.5, "ja").unwrap_err();
        assert!(
            err.contains("render_scale"),
            "error must mention render_scale, got: {err}"
        );
    }

    /// 非有限値（NaN）も拒否される（serde_json 経由では通常到達しないが防御的に）。
    #[test]
    fn do_windows_ocr_rejects_nan_render_scale() {
        let err = do_windows_ocr("unused.png", f64::NAN, "ja").unwrap_err();
        assert!(
            err.contains("render_scale"),
            "error must mention render_scale, got: {err}"
        );
    }

    // ── M2 (PCT-101): parse_run_ocr_headers テスト ──────────────────────────

    #[test]
    fn parse_run_ocr_headers_success_with_all_required() {
        let mut headers = HeaderMap::new();
        headers.insert("x-page-width", HeaderValue::from_static("595.0"));
        headers.insert("x-render-scale", HeaderValue::from_static("1.5"));

        let result = parse_run_ocr_headers(&headers).unwrap();
        assert!((result.page_width - 595.0).abs() < f64::EPSILON);
        assert!((result.render_scale - 1.5).abs() < f64::EPSILON);
        assert!(result.language_tag.is_none());
    }

    #[test]
    fn parse_run_ocr_headers_success_with_language_tag() {
        let mut headers = HeaderMap::new();
        headers.insert("x-page-width", HeaderValue::from_static("842.0"));
        headers.insert("x-render-scale", HeaderValue::from_static("2.0"));
        headers.insert("x-language-tag", HeaderValue::from_static("en-US"));

        let result = parse_run_ocr_headers(&headers).unwrap();
        assert_eq!(result.language_tag, Some("en-US".to_string()));
    }

    #[test]
    fn parse_run_ocr_headers_missing_page_width_returns_err() {
        let mut headers = HeaderMap::new();
        headers.insert("x-render-scale", HeaderValue::from_static("1.0"));

        let err = parse_run_ocr_headers(&headers).unwrap_err();
        assert_eq!(err, "missing x-page-width header");
    }

    #[test]
    fn parse_run_ocr_headers_missing_render_scale_returns_err() {
        let mut headers = HeaderMap::new();
        headers.insert("x-page-width", HeaderValue::from_static("595.0"));
        // x-render-scale を意図的に省略

        let err = parse_run_ocr_headers(&headers).unwrap_err();
        assert_eq!(err, "missing x-render-scale header");
    }

    #[test]
    fn parse_run_ocr_headers_invalid_render_scale_returns_err() {
        let mut headers = HeaderMap::new();
        headers.insert("x-page-width", HeaderValue::from_static("595.0"));
        headers.insert("x-render-scale", HeaderValue::from_static("not-a-number"));

        let err = parse_run_ocr_headers(&headers).unwrap_err();
        assert_eq!(err, "invalid x-render-scale header");
    }

    #[test]
    fn parse_run_ocr_headers_invalid_page_width_returns_err() {
        let mut headers = HeaderMap::new();
        headers.insert("x-page-width", HeaderValue::from_static("bad"));
        headers.insert("x-render-scale", HeaderValue::from_static("1.0"));

        let err = parse_run_ocr_headers(&headers).unwrap_err();
        assert_eq!(err, "invalid x-page-width header");
    }

    #[test]
    fn parse_run_ocr_headers_empty_language_tag_is_none() {
        let mut headers = HeaderMap::new();
        headers.insert("x-page-width", HeaderValue::from_static("595.0"));
        headers.insert("x-render-scale", HeaderValue::from_static("1.0"));
        headers.insert("x-language-tag", HeaderValue::from_static(""));

        let result = parse_run_ocr_headers(&headers).unwrap();
        // 空文字は filter で None になる
        assert!(result.language_tag.is_none());
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
            // PCT-116: 前回セッションが残した OCR/プレビュー temp を起動時に掃除する。
            cleanup_stale_ocr_temp_files();
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
            open_pdf_preview,
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
