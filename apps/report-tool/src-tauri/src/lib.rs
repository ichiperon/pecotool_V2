// ─────────────────────────────────────────────────────────────────────────────
// Peco 帳票ツール — Tauri バックエンド
//
// OCR 実装方針:
//   bytes 直渡し経路（StorageFile 非使用・temp ファイルを作らない）
//   InMemoryRandomAccessStream + DataWriter で bytes 書き込み
//   → Seek(0) 必須（DataWriter がカーソルを末尾に進めるため）
//   → BitmapDecoder::CreateAsync(stream) → GetSoftwareBitmapAsync
// ─────────────────────────────────────────────────────────────────────────────

// ── OCR 言語情報 ─────────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct OcrLanguageInfo {
    tag: String,
    display_name: String,
}

// ── ヘッダ構造体 ──────────────────────────────────────────────────────────────

#[derive(Debug)]
struct RunOcrHeaders {
    page_width: f64,
    render_scale: f64,
    language_tag: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// estimate_confidence
//
// Windows.Media.Ocr はワードごとの信頼度スコアを公開しないため、
// テキスト内容とジオメトリのヒューリスティックで近似する。
// ─────────────────────────────────────────────────────────────────────────────

fn estimate_confidence(text: &str, width: f64, height: f64) -> f64 {
    // 1) 空テキスト: ゴミ認識の可能性が高い
    if text.is_empty() {
        return 0.3;
    }
    let char_count = text.chars().count() as f64;
    // 2) 1 文字: 不安定な読み取り
    if char_count == 1.0 {
        return 0.5;
    }
    // 3) 記号率が高い (ASCII 句読点 + 全角記号) → 低信頼度
    let symbol_count = text
        .chars()
        .filter(|c| {
            c.is_ascii_punctuation()
                || matches!(*c, '\u{3000}'..='\u{303F}') // CJK 句読点
                || matches!(*c, '\u{FF00}'..='\u{FF1F}') // 全角 ASCII 記号
        })
        .count() as f64;
    let symbol_ratio = symbol_count / char_count;
    if symbol_ratio > 0.5 {
        return 0.5;
    }
    // 4) 極端なアスペクト比 (誤セグメンテーションの疑い)
    let aspect = if height > 0.0 { width / height } else { 1.0 };
    if aspect > 20.0 || aspect < 0.05 {
        return 0.5;
    }
    // 5) 通常ブロック: 高信頼度
    0.9
}

// ─────────────────────────────────────────────────────────────────────────────
// parse_report_ocr_headers
//
// x-render-scale 欠落は明示エラー（fallback 禁止）。
// 欠落のまま進むと座標が全ズレするため。
// ─────────────────────────────────────────────────────────────────────────────

fn parse_report_ocr_headers(headers: &tauri::http::HeaderMap) -> Result<RunOcrHeaders, String> {
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

// ─────────────────────────────────────────────────────────────────────────────
// do_report_ocr
//
// bytes 直渡し版 OCR。StorageFile・temp ファイルを作らない。
//
// 置換ポイント（本体 do_windows_ocr の 788-808 行に相当）:
//   StorageFile::GetFileFromPathAsync / OpenAsync の代わりに
//   InMemoryRandomAccessStream + DataWriter でストリームを作り、
//   bytes 書き込み後に Seek(0) してカーソルを先頭へ戻してから
//   BitmapDecoder::CreateAsync へ渡す。
//   Seek(0) を省くと DataWriter がカーソルを末尾に進めたままとなり、
//   型エラーは出ないが実機で空 blocks になる罠がある。
// ─────────────────────────────────────────────────────────────────────────────

fn do_report_ocr(
    image_bytes: &[u8],
    render_scale: f64,
    language_tag: &str,
) -> Result<String, String> {
    use windows::{
        core::HSTRING,
        Globalization::Language,
        Graphics::Imaging::BitmapDecoder,
        Media::Ocr::OcrEngine,
        Storage::Streams::{DataWriter, InMemoryRandomAccessStream},
        Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
    };

    // render_scale は bbox 座標変換の除算分母のため、0 以下・非有限値を COM 初期化前に拒否。
    if !render_scale.is_finite() || render_scale <= 0.0 {
        return Err(format!(
            "render_scaleが不正です (0より大きい有限値が必要): {render_scale}"
        ));
    }

    // このスレッドの COM 初期化
    //   S_OK  (0) = 初期化成功 → 関数終了時に CoUninitialize が必要
    //   S_FALSE(1) = 既に初期化済みだがこの呼び出し対応の CoUninitialize が必要
    //   それ以外 = 失敗
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

    // ── bytes → InMemoryRandomAccessStream ────────────────────────────────
    //
    // DataWriter でストリームに bytes を書き込む。
    // StoreAsync() 後、カーソルは末尾を指したままなので Seek(0) で先頭に戻す。
    // Seek(0) を忘れると BitmapDecoder がストリームの "空" の部分を読んでしまい
    // 型エラーは出ないが OCR 結果が空 blocks になる。
    let stream = InMemoryRandomAccessStream::new()
        .map_err(|e| format!("InMemoryRandomAccessStream 作成失敗: {e}"))?;

    let writer = DataWriter::CreateDataWriter(&stream)
        .map_err(|e| format!("DataWriter 作成失敗: {e}"))?;

    writer
        .WriteBytes(image_bytes)
        .map_err(|e| format!("WriteBytes 失敗: {e}"))?;

    writer
        .StoreAsync()
        .map_err(|e| format!("StoreAsync 失敗: {e}"))?
        .get()
        .map_err(|e| format!("StoreAsync 待機失敗: {e}"))?;

    // DataWriter を Detach してストリームへの所有権を返す。
    // DetachStream を呼ばないと Drop 時にストリームが閉じられる。
    writer.DetachStream().map_err(|e| format!("DetachStream 失敗: {e}"))?;

    // ★ Seek(0) 必須: ここを省くと BitmapDecoder が末尾から読んで空 blocks になる
    stream
        .Seek(0)
        .map_err(|e| format!("Seek(0) 失敗: {e}"))?;

    // ── BitmapDecoder → SoftwareBitmap ───────────────────────────────────
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|e| format!("デコーダー作成失敗: {e}"))?
        .get()
        .map_err(|e| format!("デコーダー作成待機失敗: {e}"))?;

    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|e| format!("ビットマップ取得失敗: {e}"))?
        .get()
        .map_err(|e| format!("ビットマップ取得待機失敗: {e}"))?;

    // ── OcrEngine 取得 ────────────────────────────────────────────────────
    let lang = Language::CreateLanguage(&HSTRING::from(language_tag))
        .map_err(|e| format!("言語設定失敗 ({}): {e}", language_tag))?;

    let engine = OcrEngine::TryCreateFromLanguage(&lang).map_err(|e| {
        format!(
            "OCRエンジン作成失敗 ({}): {e}。言語パックがインストールされていない可能性があります。\
             Windows の設定 > 時刻と言語 > 言語と地域 から対象言語を追加してください。",
            language_tag
        )
    })?;

    // ── OCR 実行 ──────────────────────────────────────────────────────────
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
        //   1. アスペクト比 (高さ > 幅 * 1.5) → 縦書き
        //   2. 複数ワードの Y 差分が X 差分より大きい → 縦書き
        //   3. 単一ワードはアスペクト比で判定済みのため horizontal にフォールバック
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
            // word_count == 1: アスペクト比条件で判定済み。幅と高さが同程度なので横書き。
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

// ─────────────────────────────────────────────────────────────────────────────
// Tauri コマンド: run_report_ocr
//
// IPC 契約:
//   body   : raw PNG bytes (Uint8Array)
//   headers: x-render-scale (必須), x-language-tag (省略時 "ja"), x-page-width (契約維持)
//   返り値 : JSON 文字列 {status:"ok", blocks:[{text, bbox, writingMode, confidence}]}
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
async fn run_report_ocr(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let headers = request.headers();
    let ocr_headers = parse_report_ocr_headers(headers)?;
    let render_scale = ocr_headers.render_scale;
    let language_tag = ocr_headers.language_tag;
    // x-page-width は現状未使用だが契約維持で読む
    let _ = ocr_headers.page_width;

    let image_bytes: Vec<u8> = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        _ => return Err("[run_report_ocr] expected raw body".to_string()),
    };

    tokio::task::spawn_blocking(move || {
        let tag = language_tag.unwrap_or_else(|| "ja".to_string());
        do_report_ocr(&image_bytes, render_scale, &tag)
    })
    .await
    .map_err(|e| format!("スレッドエラー: {}", e))?
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri コマンド: list_ocr_languages
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// greet (スケルトンから引き継ぎ)
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! — Peco 帳票ツール Phase 0", name)
}

// ─────────────────────────────────────────────────────────────────────────────
// エントリポイント
// ─────────────────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![greet, run_report_ocr, list_ocr_languages])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ─────────────────────────────────────────────────────────────────────────────
// 単体テスト
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::http::{HeaderMap, HeaderValue};

    // ── do_report_ocr render_scale ガード ────────────────────────────────────

    /// render_scale == 0 は COM 初期化・ストリーム生成前に拒否される（ゼロ除算防止）。
    #[test]
    fn do_report_ocr_rejects_zero_render_scale() {
        let err = do_report_ocr(b"", 0.0, "ja").unwrap_err();
        assert!(
            err.contains("render_scale"),
            "error must mention render_scale, got: {err}"
        );
    }

    /// 負の render_scale も拒否される。
    #[test]
    fn do_report_ocr_rejects_negative_render_scale() {
        let err = do_report_ocr(b"", -1.5, "ja").unwrap_err();
        assert!(
            err.contains("render_scale"),
            "error must mention render_scale, got: {err}"
        );
    }

    /// 非有限値（NaN）も拒否される。
    #[test]
    fn do_report_ocr_rejects_nan_render_scale() {
        let err = do_report_ocr(b"", f64::NAN, "ja").unwrap_err();
        assert!(
            err.contains("render_scale"),
            "error must mention render_scale, got: {err}"
        );
    }

    /// 正の有限値は render_scale ガードを通過する（その後 COM / Windows API でエラーが出るが
    /// それは実機領域なのでテスト対象外）。
    #[test]
    fn do_report_ocr_positive_finite_render_scale_passes_guard() {
        let err = do_report_ocr(b"", 1.0, "ja").unwrap_err();
        // render_scale ガードは通過しているため、エラーは COM/ストリーム系のはず
        assert!(
            !err.contains("render_scaleが不正です"),
            "render_scale guard should have passed, got: {err}"
        );
    }

    // ── estimate_confidence ───────────────────────────────────────────────────

    #[test]
    fn estimate_confidence_empty_text_returns_low() {
        let score = estimate_confidence("", 100.0, 20.0);
        assert!(
            (score - 0.3).abs() < f64::EPSILON,
            "empty text should be 0.3, got: {score}"
        );
    }

    #[test]
    fn estimate_confidence_single_char_returns_mid() {
        let score = estimate_confidence("A", 10.0, 10.0);
        assert!(
            (score - 0.5).abs() < f64::EPSILON,
            "single char should be 0.5, got: {score}"
        );
    }

    #[test]
    fn estimate_confidence_high_symbol_ratio_returns_low() {
        // 記号が 6/8 = 75% > 50%
        let score = estimate_confidence("!!!!!!", 100.0, 20.0);
        assert!(
            (score - 0.5).abs() < f64::EPSILON,
            "high symbol ratio should be 0.5, got: {score}"
        );
    }

    #[test]
    fn estimate_confidence_extreme_aspect_ratio_wide_returns_low() {
        // aspect = 1000 / 10 = 100 > 20
        let score = estimate_confidence("テキスト", 1000.0, 10.0);
        assert!(
            (score - 0.5).abs() < f64::EPSILON,
            "extreme wide aspect should be 0.5, got: {score}"
        );
    }

    #[test]
    fn estimate_confidence_extreme_aspect_ratio_narrow_returns_low() {
        // aspect = 5 / 1000 = 0.005 < 0.05
        let score = estimate_confidence("テキスト", 5.0, 1000.0);
        assert!(
            (score - 0.5).abs() < f64::EPSILON,
            "extreme narrow aspect should be 0.5, got: {score}"
        );
    }

    #[test]
    fn estimate_confidence_normal_text_returns_high() {
        let score = estimate_confidence("請求書", 100.0, 20.0);
        assert!(
            (score - 0.9).abs() < f64::EPSILON,
            "normal text should be 0.9, got: {score}"
        );
    }

    // ── parse_report_ocr_headers ──────────────────────────────────────────────

    #[test]
    fn parse_report_ocr_headers_success_with_all_required() {
        let mut headers = HeaderMap::new();
        headers.insert("x-page-width", HeaderValue::from_static("595.0"));
        headers.insert("x-render-scale", HeaderValue::from_static("1.5"));

        let result = parse_report_ocr_headers(&headers).unwrap();
        assert!((result.page_width - 595.0).abs() < f64::EPSILON);
        assert!((result.render_scale - 1.5).abs() < f64::EPSILON);
        assert!(result.language_tag.is_none());
    }

    #[test]
    fn parse_report_ocr_headers_success_with_language_tag() {
        let mut headers = HeaderMap::new();
        headers.insert("x-page-width", HeaderValue::from_static("842.0"));
        headers.insert("x-render-scale", HeaderValue::from_static("2.0"));
        headers.insert("x-language-tag", HeaderValue::from_static("en-US"));

        let result = parse_report_ocr_headers(&headers).unwrap();
        assert_eq!(result.language_tag, Some("en-US".to_string()));
    }

    #[test]
    fn parse_report_ocr_headers_missing_page_width_returns_err() {
        let mut headers = HeaderMap::new();
        headers.insert("x-render-scale", HeaderValue::from_static("1.0"));

        let err = parse_report_ocr_headers(&headers).unwrap_err();
        assert_eq!(err, "missing x-page-width header");
    }

    #[test]
    fn parse_report_ocr_headers_missing_render_scale_returns_err() {
        let mut headers = HeaderMap::new();
        headers.insert("x-page-width", HeaderValue::from_static("595.0"));
        // x-render-scale を意図的に省略

        let err = parse_report_ocr_headers(&headers).unwrap_err();
        assert_eq!(err, "missing x-render-scale header");
    }

    #[test]
    fn parse_report_ocr_headers_invalid_render_scale_returns_err() {
        let mut headers = HeaderMap::new();
        headers.insert("x-page-width", HeaderValue::from_static("595.0"));
        headers.insert("x-render-scale", HeaderValue::from_static("not-a-number"));

        let err = parse_report_ocr_headers(&headers).unwrap_err();
        assert_eq!(err, "invalid x-render-scale header");
    }

    #[test]
    fn parse_report_ocr_headers_invalid_page_width_returns_err() {
        let mut headers = HeaderMap::new();
        headers.insert("x-page-width", HeaderValue::from_static("bad"));
        headers.insert("x-render-scale", HeaderValue::from_static("1.0"));

        let err = parse_report_ocr_headers(&headers).unwrap_err();
        assert_eq!(err, "invalid x-page-width header");
    }

    #[test]
    fn parse_report_ocr_headers_empty_language_tag_is_none() {
        let mut headers = HeaderMap::new();
        headers.insert("x-page-width", HeaderValue::from_static("595.0"));
        headers.insert("x-render-scale", HeaderValue::from_static("1.0"));
        headers.insert("x-language-tag", HeaderValue::from_static(""));

        let result = parse_report_ocr_headers(&headers).unwrap();
        // 空文字は filter で None になる
        assert!(result.language_tag.is_none());
    }
}
