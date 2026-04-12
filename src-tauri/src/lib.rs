mod backup;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            run_ocr,
            backup::save_backup,
            backup::check_pending_backups,
            backup::clear_backup,
            backup::load_backup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
