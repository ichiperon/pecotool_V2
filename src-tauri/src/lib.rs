mod backup;

/// PDF の /MediaBox (or /CropBox) を直接パースし、全ページの論理寸法を返す。
/// pdfjs の getPage().getViewport() と比較して10倍以上高速。
/// 各タプルは (width_pt, height_pt)。/Rotate 90/270 は swap 済み。
/// パース不能ページは (0.0, 0.0) を返す。load 失敗時のみ Err を返す。
#[tauri::command]
async fn get_pdf_page_dimensions(file_path: String) -> Result<Vec<(f64, f64)>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<(f64, f64)>, String> {
        use lopdf::{Document, Object, ObjectId};

        let doc = Document::load(&file_path)
            .map_err(|e| format!("PDF load failed: {}", e))?;

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
                                    if let (Some(a), Some(b), Some(c), Some(d)) =
                                        (parse(&arr[0]), parse(&arr[1]), parse(&arr[2]), parse(&arr[3]))
                                    {
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
        format!("perf-{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0))
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
        format!("log-{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0))
    } else {
        safe_name
    };
    let path = logs_dir.join(format!("{}.ndjson", safe_name));
    fs::write(&path, body).map_err(|e| format!("write: {e}"))?;
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

#[tauri::command]
async fn run_ocr(
    image_path: String,
    page_width: f64,
    page_height: f64,
    render_scale: f64,
) -> Result<String, String> {
    let _ = (page_width, page_height); // 座標変換は render_scale のみ使用
    let result = tokio::task::spawn_blocking(move || do_windows_ocr(&image_path, render_scale))
        .await
        .map_err(|e| format!("スレッドエラー: {}", e))??;
    Ok(result)
}

fn do_windows_ocr(image_path: &str, render_scale: f64) -> Result<String, String> {
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
    // S_FALSE (1)   = 既に初期化済み → CoUninitialize を呼んではいけない
    // それ以外       = 失敗
    let needs_uninit = unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() && hr.0 != 0x00000001u32 as i32 {
            return Err(format!("COM初期化失敗: {:?}", hr));
        }
        hr.0 == 0 // S_OK のみ CoUninitialize が必要
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

    let lang = Language::CreateLanguage(&HSTRING::from("ja"))
        .map_err(|e| format!("言語設定失敗: {e}"))?;

    let engine = OcrEngine::TryCreateFromLanguage(&lang)
        .map_err(|e| format!("OCRエンジン作成失敗: {e}"))?;

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
        let words = line.Words().map_err(|e| format!("ワードリスト取得失敗: {e}"))?;
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
            let first_word = words.GetAt(0).map_err(|e| format!("Word(0)取得失敗: {e}"))?;
            let last_word = words.GetAt(word_count - 1).map_err(|e| format!("Word(last)取得失敗: {e}"))?;
            let first_rect = first_word.BoundingRect().map_err(|e| format!("BBox(0)取得失敗: {e}"))?;
            let last_rect = last_word.BoundingRect().map_err(|e| format!("BBox(last)取得失敗: {e}"))?;
            let dy = (last_rect.Y - first_rect.Y).abs();
            let dx = (last_rect.X - first_rect.X).abs();
            if dy > dx * 2.0 { "vertical" } else { "horizontal" }
        } else {
            // word_count == 1: アスペクト比条件（h > w * 1.5）で判定済み。
            // ここに来た場合は幅が高さと同程度かそれ以上なので横書きとみなす。
            "horizontal"
        };

        blocks.push(serde_json::json!({
            "text": text_parts.join(""),
            "bbox": { "x": x, "y": y, "width": w, "height": h },
            "writingMode": writing_mode,
            "confidence": 1.0
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
///
/// フロント側はバイナリを Uint8Array のまま `invoke(cmd, bytes, { headers })` で渡す。
#[tauri::command]
async fn write_pdf_chunk(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    use std::io::{Seek, SeekFrom, Write};
    use std::fs::OpenOptions;

    let headers = request.headers();
    let path_raw = headers
        .get("x-path")
        .and_then(|h| h.to_str().ok())
        .ok_or_else(|| "missing x-path header".to_string())?;
    let path = percent_decode(path_raw);
    let offset: u64 = headers
        .get("x-offset")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let bytes: Vec<u8> = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        _ => return Err("[write_pdf_chunk] expected raw body".to_string()),
    };

    tokio::task::spawn_blocking(move || -> Result<(), String> {
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
            .map_err(|e| format!("open failed: {} ({})", e, path))?;
        if offset > 0 {
            f.seek(SeekFrom::Start(offset))
                .map_err(|e| format!("seek failed: {}", e))?;
        }
        f.write_all(&bytes).map_err(|e| format!("write failed: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {}", e))?
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
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
            run_ocr,
            get_pdf_page_dimensions,
            write_perf_log,
            write_operation_log,
            open_log_folder,
            write_pdf_chunk,
            backup::save_backup,
            backup::check_pending_backups,
            backup::clear_backup,
            backup::load_backup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
