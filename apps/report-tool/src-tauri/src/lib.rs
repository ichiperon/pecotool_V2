// ─────────────────────────────────────────────────────────────────────────────
// Peco 帳票ツール — Tauri バックエンド
//
// OCR 実装方針:
//   bytes 直渡し経路（StorageFile 非使用・temp ファイルを作らない）
//   InMemoryRandomAccessStream + DataWriter で bytes 書き込み
//   → Seek(0) 必須（DataWriter がカーソルを末尾に進めるため）
//   → BitmapDecoder::CreateAsync(stream) → GetSoftwareBitmapAsync
// ─────────────────────────────────────────────────────────────────────────────

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

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
                // 全角 ASCII 記号（U+FF00-FF1F）から全角数字（U+FF10-FF19 ０-９）を除外。
                // 除外しないと全角数字が常に記号扱いになり、金額セルが常時低信頼(0.5)判定される。
                || matches!(*c, '\u{FF00}'..='\u{FF0F}') // ！＂＃＄％＆＇（）＊＋，－．／ 等
                || matches!(*c, '\u{FF1A}'..='\u{FF1F}') // ：；＜＝＞？
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
// csv_bytes_with_bom / save_csv
//
// Excel の文字コード自動判定を UTF-8 に確定させるため、
// BOM (0xEF 0xBB 0xBF) を先頭に付与してから一意な temp ファイルへ全量書込みし、
// atomic_replace_file で最終パスへ置換する（テンプレート/セッション永続化と同方針）。
// 旧実装は保存先を std::fs::write で直接 truncate しており、書込み途中でクラッシュ・
// 電源断が起きると CSV が壊れた状態（torn write）で残っていた（#451 / PCT-215）。
//
// plugin-fs を経由しないため fs-scope 検証（\\?\ 正規化の罠を含む）に掛からない。
// 本体の write_pdf_chunk / OCR temp と同じ考え方。
// ─────────────────────────────────────────────────────────────────────────────

/// BOM 付き UTF-8 バイト列を生成する純関数。
/// save_csv_to_path が内部で利用し、単体テストもここに当てる。
fn csv_bytes_with_bom(csv: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(3 + csv.len());
    bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    bytes.extend_from_slice(csv.as_bytes());
    bytes
}

/// 保存の都度、一意な temp ファイル名を生成する（同一ディレクトリ・同一ファイル名接頭辞）。
/// 固定名だと連打・二重起動などの並行 save が同じ temp を取り合い、書込み中の内容を
/// 別スレッドが truncate/rename で踏みうる。プロセスID + プロセス内カウンタで
/// 一意性を確保する（backup.rs write_backup_file_atomically と同じ方針）。
fn csv_temp_file_path(path: &Path) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let file_name = path.file_name().and_then(|f| f.to_str()).unwrap_or("output.csv");
    path.with_file_name(format!("{file_name}.{}.{}.tmp", std::process::id(), n))
}

/// CSV を temp 書込 → sync_all → atomic rename で保存する純関数。
/// テスト容易性のため #[tauri::command] から切り出している。
fn save_csv_to_path(path: &Path, csv: &str) -> Result<(), String> {
    let temp_path = csv_temp_file_path(path);
    save_csv_via_temp(path, csv, &temp_path)
}

/// save_csv_to_path の実処理。temp_path を引数化しているのはテストのためだけの都合
/// （csv_temp_file_path はプロセス内カウンタで一意名を生成するため、失敗系テストが
/// 「書込み先を事前にディレクトリとして塞ぐ」ために確定パスを必要とする）。
fn save_csv_via_temp(path: &Path, csv: &str, temp_path: &Path) -> Result<(), String> {
    let bytes = csv_bytes_with_bom(csv);

    let write_result = (|| -> Result<(), String> {
        let mut file = std::fs::File::create(temp_path)
            .map_err(|e| format!("CSVの一時保存に失敗しました: {e}"))?;
        file.write_all(&bytes)
            .map_err(|e| format!("CSVの一時保存に失敗しました: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("CSVの一時保存の同期に失敗しました: {e}"))?;
        Ok(())
    })();

    let result = match write_result {
        Ok(()) => atomic_replace_file(temp_path, path),
        Err(e) => Err(e),
    };

    if result.is_err() {
        // rename 未到達 or 失敗時は temp を残さない。掃除自体の失敗は握りつぶさず可視化する
        // （save_template_to_dir / save_session_to_dir と同じ考え方）。
        if let Err(cleanup_err) = std::fs::remove_file(temp_path) {
            eprintln!(
                "[csv] failed to remove temp file after write error: {} ({cleanup_err})",
                temp_path.display()
            );
        }
    }
    result
}

/// ユーザーが保存ダイアログで選んだパスへ CSV を BOM 付き UTF-8 で保存する。
/// plugin-fs を経由せず std::fs を直接使うため fs-scope 検証に掛からない。
#[tauri::command]
async fn save_csv(path: String, csv: String) -> Result<(), String> {
    save_csv_to_path(Path::new(&path), &csv)
}

// ─────────────────────────────────────────────────────────────────────────────
// テンプレート永続化 (save_template / list_templates / load_template / delete_template)
//
// 保存先: app_data_dir()/templates/<id>.json
// 書込は <id>.json.tmp に書いてから atomic rename で確定する（torn write 防止）。
// plugin-fs を経由せず std::fs 直書きのため fs-scope 検証には掛からない
// （save_csv と同じ考え方）。
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TemplateSummary {
    id: String,
    name: String,
    saved_at: String,
    schema_version: u32,
    readable: bool,
}

/// テンプレートIDのバリデーション。
///
/// id はファイル名にそのまま使われるため、`.`/`/`/`\`/`..` を含む文字列を
/// 許容するとパストラバーサル（例: `../../secret`）でテンプレートディレクトリ外へ
/// 読み書きできてしまう。uuid 相当の 16 進数字とハイフンのみをホワイトリストで許可する。
fn validate_template_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("テンプレートIDが空です".to_string());
    }
    if !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err(format!("不正なテンプレートIDです: {id}"));
    }
    Ok(())
}

fn template_file_path(templates_dir: &Path, id: &str) -> PathBuf {
    templates_dir.join(format!("{id}.json"))
}

fn template_temp_file_path(templates_dir: &Path, id: &str) -> PathBuf {
    templates_dir.join(format!("{id}.json.tmp"))
}

/// テンプレートを保存する。id 検証 → temp 書込 → atomic rename の順で行い、
/// rename が完了するまで既存の final ファイルには一切触れない
/// （書込途中で中断しても既存ファイルは無傷のまま = torn write 防止）。
fn save_template_to_dir(templates_dir: &Path, id: &str, json: &str) -> Result<(), String> {
    validate_template_id(id)?;
    std::fs::create_dir_all(templates_dir)
        .map_err(|e| format!("テンプレートディレクトリの作成に失敗しました: {e}"))?;

    let temp_path = template_temp_file_path(templates_dir, id);
    let final_path = template_file_path(templates_dir, id);

    std::fs::write(&temp_path, json.as_bytes())
        .map_err(|e| format!("テンプレートの一時保存に失敗しました: {e}"))?;

    let result = atomic_replace_file(&temp_path, &final_path);
    if result.is_err() {
        // rename 失敗時は temp を残さない。掃除自体の失敗は握りつぶさず可視化する
        // （動作は fail-open のまま継続、backup.rs write_backup_file_atomically と同じ考え方）。
        if let Err(cleanup_err) = std::fs::remove_file(&temp_path) {
            eprintln!(
                "[template] failed to remove temp file after write error: {} ({cleanup_err})",
                temp_path.display()
            );
        }
    }
    result
}

/// テンプレートの生 JSON 文字列を読み込む。parse は呼び出し元（TS 側）で行う。
fn load_template_from_dir(templates_dir: &Path, id: &str) -> Result<String, String> {
    validate_template_id(id)?;
    let path = template_file_path(templates_dir, id);
    std::fs::read_to_string(&path).map_err(|e| format!("テンプレートの読み込みに失敗しました: {e}"))
}

fn delete_template_from_dir(templates_dir: &Path, id: &str) -> Result<(), String> {
    validate_template_id(id)?;
    let path = template_file_path(templates_dir, id);
    std::fs::remove_file(&path).map_err(|e| format!("テンプレートの削除に失敗しました: {e}"))?;
    Ok(())
}

/// templates_dir 内の *.json を列挙してサマリを返す。
/// 1件でも parse に失敗しても全体を Err にせず、その1件だけ readable:false として返す
/// （被害を壊れたファイル1件に局所化し、他の正常なテンプレートの一覧性を守る）。
fn list_templates_from_dir(templates_dir: &Path) -> Result<Vec<TemplateSummary>, String> {
    std::fs::create_dir_all(templates_dir)
        .map_err(|e| format!("テンプレートディレクトリの作成に失敗しました: {e}"))?;

    let entries = std::fs::read_dir(templates_dir)
        .map_err(|e| format!("テンプレート一覧の取得に失敗しました: {e}"))?;

    let mut result = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        // .json.tmp や拡張子なしファイルは対象外（拡張子が "json" のものだけを扱う）。
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        result.push(read_template_summary(id, &path));
    }
    Ok(result)
}

fn read_template_summary(id: &str, path: &Path) -> TemplateSummary {
    let unreadable = || TemplateSummary {
        id: id.to_string(),
        name: String::new(),
        saved_at: String::new(),
        schema_version: 0,
        readable: false,
    };

    let Ok(content) = std::fs::read_to_string(path) else {
        return unreadable();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else {
        return unreadable();
    };

    TemplateSummary {
        id: id.to_string(),
        name: value.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        saved_at: value.get("savedAt").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        schema_version: value.get("schemaVersion").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        readable: true,
    }
}

/// temp → final への atomic rename。
///
/// Windows では単純な `std::fs::rename` の置換保証がクレート実装依存で変わりうるため、
/// backup.rs write_backup_file_atomically と同じく MoveFileExW を
/// MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH で直接呼び、置換の原子性を確定させる。
#[cfg(windows)]
fn atomic_replace_file(temp: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;

    let temp_w: Vec<u16> = temp
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let target_w: Vec<u16> = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let ok = unsafe {
        MoveFileExW(
            temp_w.as_ptr(),
            target_w.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        return Err(format!(
            "テンプレート atomic replace 失敗: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace_file(temp: &Path, target: &Path) -> Result<(), String> {
    std::fs::rename(temp, target).map_err(|e| format!("ファイルの atomic rename 失敗: {e}"))
}

/// app_data_dir()/templates を解決する。存在しなくてもここでは作らない
/// （作成は save_template_to_dir / list_templates_from_dir 側の create_dir_all に委ねる）。
fn resolve_templates_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let mut dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("アプリデータディレクトリの解決に失敗しました: {e}"))?;
    dir.push("templates");
    Ok(dir)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri コマンド: save_template / list_templates / load_template / delete_template
//
// IPC 契約:
//   save_template(id: String, json: String) -> Result<(), String>
//   list_templates() -> Result<Vec<TemplateSummary>, String>
//     TemplateSummary (camelCase): { id, name, savedAt, schemaVersion, readable }
//   load_template(id: String) -> Result<String, String>  … 生 JSON 文字列（parse は TS 側）
//   delete_template(id: String) -> Result<(), String>
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
async fn save_template(app: tauri::AppHandle, id: String, json: String) -> Result<(), String> {
    let dir = resolve_templates_dir(&app)?;
    save_template_to_dir(&dir, &id, &json)
}

#[tauri::command]
async fn list_templates(app: tauri::AppHandle) -> Result<Vec<TemplateSummary>, String> {
    let dir = resolve_templates_dir(&app)?;
    list_templates_from_dir(&dir)
}

#[tauri::command]
async fn load_template(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let dir = resolve_templates_dir(&app)?;
    load_template_from_dir(&dir, &id)
}

#[tauri::command]
async fn delete_template(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let dir = resolve_templates_dir(&app)?;
    delete_template_from_dir(&dir, &id)
}

// ─────────────────────────────────────────────────────────────────────────────
// 作業セッション永続化 (save_session / load_session / clear_session)
//
// 保存先: app_data_dir()/session/current.json（単一スロット）
// テンプレートと同じ「temp 書込 → atomic rename」で torn write を防ぐ。
// JSON の中身（スキーマ・バージョン）は TS 側 sessionCodec が管理し、
// Rust は生文字列の入出力のみを担う（テンプレートと同じ責務分割）。
//
// IPC 契約:
//   save_session(json: String) -> Result<(), String>
//   load_session() -> Result<String, String>   … 無ければ Err（TS 側で「なし」として扱う）
//   clear_session() -> Result<(), String>      … 無くても Ok（冪等）
// ─────────────────────────────────────────────────────────────────────────────

/// app_data_dir()/session を解決する（作成は保存時の create_dir_all に委ねる）。
fn resolve_session_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let mut dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("アプリデータディレクトリの解決に失敗しました: {e}"))?;
    dir.push("session");
    Ok(dir)
}

fn session_file_path(session_dir: &Path) -> PathBuf {
    session_dir.join("current.json")
}

/// 保存の都度、一意な temp ファイル名を生成する。
/// 固定名 "current.json.tmp" だと並行 save（デバウンス発火と flushNow の競合等）が
/// 同じ temp を取り合い、truncate/rename が競合しうる（#450 backend / PCT-214）。
/// csv_temp_file_path と同じ方針でプロセスID + プロセス内カウンタで一意性を確保する。
fn session_temp_file_path(session_dir: &Path) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    session_dir.join(format!("current.{}.{}.json.tmp", std::process::id(), n))
}

/// セッションを保存する。temp 書込 → atomic rename（save_template_to_dir と同方針）。
fn save_session_to_dir(session_dir: &Path, json: &str) -> Result<(), String> {
    std::fs::create_dir_all(session_dir)
        .map_err(|e| format!("セッションディレクトリの作成に失敗しました: {e}"))?;

    let temp_path = session_temp_file_path(session_dir);
    let final_path = session_file_path(session_dir);

    std::fs::write(&temp_path, json.as_bytes())
        .map_err(|e| format!("セッションの一時保存に失敗しました: {e}"))?;

    let result = atomic_replace_file(&temp_path, &final_path);
    if result.is_err() {
        if let Err(cleanup_err) = std::fs::remove_file(&temp_path) {
            eprintln!(
                "[session] failed to remove temp file after write error: {} ({cleanup_err})",
                temp_path.display()
            );
        }
    }
    result
}

fn load_session_from_dir(session_dir: &Path) -> Result<String, String> {
    let path = session_file_path(session_dir);
    std::fs::read_to_string(&path).map_err(|e| format!("セッションの読み込みに失敗しました: {e}"))
}

/// セッションを削除する。存在しない場合も Ok（冪等）。
fn clear_session_in_dir(session_dir: &Path) -> Result<(), String> {
    let path = session_file_path(session_dir);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("セッションの削除に失敗しました: {e}")),
    }
}

#[tauri::command]
async fn save_session(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let dir = resolve_session_dir(&app)?;
    save_session_to_dir(&dir, &json)
}

#[tauri::command]
async fn load_session(app: tauri::AppHandle) -> Result<String, String> {
    let dir = resolve_session_dir(&app)?;
    load_session_from_dir(&dir)
}

#[tauri::command]
async fn clear_session(app: tauri::AppHandle) -> Result<(), String> {
    let dir = resolve_session_dir(&app)?;
    clear_session_in_dir(&dir)
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
        .invoke_handler(tauri::generate_handler![
            greet,
            run_report_ocr,
            list_ocr_languages,
            save_csv,
            save_template,
            list_templates,
            load_template,
            delete_template,
            save_session,
            load_session,
            clear_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ─────────────────────────────────────────────────────────────────────────────
// 単体テスト
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
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

    // PCT-200 MA-8: 全角数字（U+FF10-FF19）は記号ではないため、記号率判定に含めてはいけない。
    // 金額セルの多くは全角数字のみで構成されるため、ここが誤って symbol 扱いだと
    // 常時 0.5 (低信頼) になりハイライトが氾濫する。
    #[test]
    fn estimate_confidence_fullwidth_digits_returns_high() {
        // "１２３４５６" は全角数字6文字のみ。記号は0文字なので symbol_ratio=0 → 高信頼のはず。
        let score = estimate_confidence("１２３４５６", 100.0, 20.0);
        assert!(
            (score - 0.9).abs() < f64::EPSILON,
            "fullwidth digits should not be treated as symbols, expected 0.9, got: {score}"
        );
    }

    #[test]
    fn estimate_confidence_fullwidth_digits_with_yen_mark_returns_high() {
        // "￥１２，０００" 相当のケース: 全角数字4 + 全角カンマ1 = symbol_ratio = 1/5 = 20% <= 50%
        let score = estimate_confidence("１２，０００", 100.0, 20.0);
        assert!(
            (score - 0.9).abs() < f64::EPSILON,
            "mostly fullwidth digits with one fullwidth comma should stay high, got: {score}"
        );
    }

    #[test]
    fn estimate_confidence_fullwidth_symbol_range_boundaries_still_low() {
        // U+FF0C(，) と U+FF1A(：) は全角数字レンジの外側の記号。分割後も記号率判定は機能すること。
        let score = estimate_confidence("，，，：：：", 100.0, 20.0);
        assert!(
            (score - 0.5).abs() < f64::EPSILON,
            "fullwidth symbols outside the digit range should still count as symbols, got: {score}"
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

    // ── csv_bytes_with_bom ────────────────────────────────────────────────────

    /// 先頭 3 バイトが UTF-8 BOM (0xEF 0xBB 0xBF) であること。
    #[test]
    fn csv_bytes_with_bom_starts_with_bom() {
        let bytes = csv_bytes_with_bom("a,b\n1,2");
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF], "先頭3バイトがBOMでなければならない");
    }

    /// BOM の後に本文 UTF-8 が続くこと。
    #[test]
    fn csv_bytes_with_bom_body_follows_bom() {
        let csv = "a,b\n1,2";
        let bytes = csv_bytes_with_bom(csv);
        assert_eq!(&bytes[3..], csv.as_bytes(), "BOM後の本文がCSV文字列と一致しなければならない");
    }

    /// 空文字入力では BOM のみ 3 バイトになること。
    #[test]
    fn csv_bytes_with_bom_empty_csv_is_bom_only() {
        let bytes = csv_bytes_with_bom("");
        assert_eq!(bytes, vec![0xEF, 0xBB, 0xBF], "空CSVはBOM3バイトのみ");
    }

    // ── テンプレート永続化 ────────────────────────────────────────────────────

    /// テスト用の一意な templates_dir を作成して返す。
    /// `tempfile` クレートを増やさないため std::env::temp_dir + プロセス内カウンタで衝突回避する
    /// （backup.rs make_backup_dir と同じ方針）。
    fn make_templates_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let mut dir = std::env::temp_dir();
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        dir.push(format!(
            "report_tool_template_test_{}_{}_{}",
            std::process::id(),
            tag,
            n
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("templates_dir 作成失敗");
        dir
    }

    // ── validate_template_id ──────────────────────────────────────────────────

    #[test]
    fn validate_template_id_accepts_uuid_like() {
        assert!(validate_template_id("a1b2c3d4-0000-0000-0000-000000000000").is_ok());
    }

    #[test]
    fn validate_template_id_rejects_empty() {
        assert!(validate_template_id("").is_err());
    }

    #[test]
    fn validate_template_id_rejects_path_traversal() {
        assert!(validate_template_id("../../etc/passwd").is_err());
        assert!(validate_template_id("..").is_err());
        assert!(validate_template_id("a/b").is_err());
        assert!(validate_template_id("a\\b").is_err());
        assert!(validate_template_id("a.b").is_err());
    }

    #[test]
    fn validate_template_id_rejects_additional_dangerous_patterns() {
        // 絶対パス（Windows）
        assert!(validate_template_id("C:\\Windows\\System32").is_err());
        // 絶対パス（Unix）
        assert!(validate_template_id("/etc/passwd").is_err());
        // 日本語（非ASCII）
        assert!(validate_template_id("テンプレ1").is_err());
        // 二重拡張子（拡張子は id に含めない契約のため拒否されるべき）
        assert!(validate_template_id("valid-id.json").is_err());
    }

    // ── save_template_to_dir / load_template_from_dir ──────────────────────────

    #[test]
    fn save_and_load_template_roundtrip() {
        let dir = make_templates_dir("roundtrip");
        let id = "aaaa1111-bbbb-2222-cccc-333344445555";
        let json = r#"{"name":"請求書テンプレ","savedAt":"2026-07-08T00:00:00Z","schemaVersion":1}"#;

        save_template_to_dir(&dir, id, json).unwrap();
        let loaded = load_template_from_dir(&dir, id).unwrap();
        assert_eq!(loaded, json);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_template_rejects_invalid_id() {
        let dir = make_templates_dir("save_invalid_id");
        let err = save_template_to_dir(&dir, "../evil", "{}").unwrap_err();
        assert!(err.contains("不正なテンプレートID"), "got: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_template_rejects_invalid_id() {
        let dir = make_templates_dir("load_invalid_id");
        let err = load_template_from_dir(&dir, "a/../b").unwrap_err();
        assert!(err.contains("不正なテンプレートID"), "got: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_template_missing_file_returns_err() {
        let dir = make_templates_dir("load_missing");
        let err = load_template_from_dir(&dir, "0000-0000").unwrap_err();
        assert!(err.contains("読み込み"), "got: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_template_no_leftover_tmp_file_after_success() {
        let dir = make_templates_dir("no_leftover");
        let id = "1111-2222";
        save_template_to_dir(&dir, id, "{}").unwrap();

        let tmp_path = dir.join(format!("{id}.json.tmp"));
        assert!(!tmp_path.exists(), "成功後に tmp ファイルが残ってはいけない");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_template_overwrite_replaces_content_atomically() {
        let dir = make_templates_dir("overwrite");
        let id = "eeee-5555";
        save_template_to_dir(&dir, id, r#"{"v":1}"#).unwrap();
        save_template_to_dir(&dir, id, r#"{"v":2}"#).unwrap();

        let loaded = load_template_from_dir(&dir, id).unwrap();
        assert_eq!(loaded, r#"{"v":2}"#);

        let tmp_path = dir.join(format!("{id}.json.tmp"));
        assert!(!tmp_path.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// temp 書込段階で失敗した場合（クラッシュ相当のシミュレーション）、
    /// rename は一切実行されず既存の final ファイルは無傷のまま残ることを確認する
    /// （torn write 防止＝アトミック性の間接検証）。
    #[test]
    fn save_template_failure_before_rename_leaves_existing_file_untouched() {
        let dir = make_templates_dir("failure_before_rename");
        let id = "ffff-6666";
        save_template_to_dir(&dir, id, r#"{"v":"original"}"#).unwrap();

        // temp パスをあらかじめディレクトリとして作っておき、
        // 次の std::fs::write(temp_path, ...) を強制的に失敗させる。
        let tmp_path = dir.join(format!("{id}.json.tmp"));
        std::fs::create_dir_all(&tmp_path).unwrap();

        let err = save_template_to_dir(&dir, id, r#"{"v":"corrupted"}"#).unwrap_err();
        assert!(!err.is_empty());

        // rename まで到達していないため、既存の final ファイルは書き換わっていない。
        let loaded = load_template_from_dir(&dir, id).unwrap();
        assert_eq!(loaded, r#"{"v":"original"}"#);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── delete_template_from_dir ────────────────────────────────────────────

    #[test]
    fn delete_template_removes_file_and_subsequent_load_fails() {
        let dir = make_templates_dir("delete");
        let id = "cccc-3333";
        save_template_to_dir(&dir, id, "{}").unwrap();
        assert!(load_template_from_dir(&dir, id).is_ok());

        delete_template_from_dir(&dir, id).unwrap();
        assert!(load_template_from_dir(&dir, id).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_template_nonexistent_returns_err() {
        let dir = make_templates_dir("delete_missing");
        let err = delete_template_from_dir(&dir, "dddd-4444").unwrap_err();
        assert!(err.contains("削除"), "got: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_template_rejects_invalid_id() {
        let dir = make_templates_dir("delete_invalid_id");
        let err = delete_template_from_dir(&dir, "../x").unwrap_err();
        assert!(err.contains("不正なテンプレートID"), "got: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── list_templates_from_dir ─────────────────────────────────────────────

    #[test]
    fn list_templates_empty_dir_returns_empty_vec() {
        let dir = make_templates_dir("list_empty");
        let list = list_templates_from_dir(&dir).unwrap();
        assert!(list.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_templates_returns_summary_for_valid_json() {
        let dir = make_templates_dir("list_valid");
        let id = "9999-8888";
        let json = r#"{"name":"見積書","savedAt":"2026-01-01T00:00:00Z","schemaVersion":2}"#;
        save_template_to_dir(&dir, id, json).unwrap();

        let list = list_templates_from_dir(&dir).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, id);
        assert_eq!(list[0].name, "見積書");
        assert_eq!(list[0].saved_at, "2026-01-01T00:00:00Z");
        assert_eq!(list[0].schema_version, 2);
        assert!(list[0].readable);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 破損した1件があっても list 全体は成功し、破損ファイルだけ readable:false になる
    /// （被害の局所化＝他の正常なテンプレートは読める）。
    #[test]
    fn list_templates_marks_corrupt_file_unreadable_without_failing_whole_list() {
        let dir = make_templates_dir("list_corrupt");
        save_template_to_dir(
            &dir,
            "aaaa-1111",
            r#"{"name":"正常","savedAt":"2026-01-01T00:00:00Z","schemaVersion":1}"#,
        )
        .unwrap();
        // 破損 JSON を直接書き込む（save_template_to_dir 経由だと validate に弾かれるため直書き）。
        std::fs::write(dir.join("bbbb-2222.json"), "{not valid json").unwrap();

        let list = list_templates_from_dir(&dir).unwrap();
        assert_eq!(list.len(), 2, "破損ファイルがあっても一覧全体は失敗してはいけない");

        let corrupt = list.iter().find(|t| t.id == "bbbb-2222").unwrap();
        assert!(!corrupt.readable);
        assert_eq!(corrupt.name, "");
        assert_eq!(corrupt.saved_at, "");
        assert_eq!(corrupt.schema_version, 0);

        let normal = list.iter().find(|t| t.id == "aaaa-1111").unwrap();
        assert!(normal.readable);
        assert_eq!(normal.name, "正常");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// .json.tmp ファイルは一覧に出てはいけない（save 中間状態が UI に漏れないこと）。
    #[test]
    fn list_templates_ignores_tmp_files() {
        let dir = make_templates_dir("list_ignores_tmp");
        std::fs::write(dir.join("leftover-tmp.json.tmp"), "{}").unwrap();

        let list = list_templates_from_dir(&dir).unwrap();
        assert!(list.is_empty(), ".json.tmp は一覧に含めてはいけない");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── セッション永続化 ──────────────────────────────────────────────

    fn temp_session_dir(name: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("peco-session-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// 指定ディレクトリ直下に残る *.tmp ファイルを列挙する。
    /// session_temp_file_path が一意名を返すようになったため（#450 backend）、
    /// 「特定の1パスが存在しない」ではなく「ディレクトリ全体に tmp が残っていない」で
    /// 検証する（save_template 系の tmp leftover テストと同じ考え方）。
    fn list_tmp_leftovers(dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("tmp"))
            .collect()
    }

    #[test]
    fn session_save_load_roundtrip() {
        let dir = temp_session_dir("roundtrip");
        save_session_to_dir(&dir, r#"{"version":1}"#).unwrap();
        let loaded = load_session_from_dir(&dir).unwrap();
        assert_eq!(loaded, r#"{"version":1}"#);
        // 上書き保存で置き換わる
        save_session_to_dir(&dir, r#"{"version":2}"#).unwrap();
        assert_eq!(load_session_from_dir(&dir).unwrap(), r#"{"version":2}"#);
        // temp ファイルが残っていない
        let leftovers = list_tmp_leftovers(&dir);
        assert!(leftovers.is_empty(), "tmp leftovers: {:?}", leftovers);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn session_load_without_file_is_err() {
        let dir = temp_session_dir("missing");
        assert!(load_session_from_dir(&dir).is_err());
    }

    #[test]
    fn session_clear_is_idempotent() {
        let dir = temp_session_dir("clear");
        // 無い状態で clear → Ok
        clear_session_in_dir(&dir).unwrap();
        save_session_to_dir(&dir, "{}").unwrap();
        clear_session_in_dir(&dir).unwrap();
        assert!(load_session_from_dir(&dir).is_err());
        // 二重 clear も Ok
        clear_session_in_dir(&dir).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 連続呼び出しで同じ temp パスを返さないこと（#450 backend の一意性の直接検証）。
    #[test]
    fn session_temp_file_path_generates_unique_names() {
        let dir = temp_session_dir("temp_unique");
        let a = session_temp_file_path(&dir);
        let b = session_temp_file_path(&dir);
        assert_ne!(a, b, "連続呼び出しで同じ temp パスを返してはいけない（並行保存の衝突防止）");
    }

    /// 2スレッドから同時に save しても、一意 temp 名により互いの temp を壊すことはなく、
    /// 最終状態は torn write（中途半端な内容の混入）なしでどちらか一方の完全な内容に
    /// なり、tmp の残骸も残らないこと。
    ///
    /// 固定 temp 名時代に起きえた「temp の truncate/rename 競合」は一意名で解消したが、
    /// 最終 rename 先（session_file_path）自体は単一スロットで共有のため、真に同時の
    /// MoveFileExW が Windows 側で一時的な ERROR_ACCESS_DENIED になり得点で片側だけ
    /// リトライなしで失敗することがある（フロント側の single-flight 化 #450 frontend が
    /// 本来の防止策）。ここでは「壊れない」ことを検証し、「両方成功する」ことまでは
    /// 求めない。
    #[test]
    fn session_save_concurrent_writes_leave_consistent_state_without_tmp_leftovers() {
        let dir = temp_session_dir("concurrent");
        std::fs::create_dir_all(&dir).unwrap();

        let dir1 = dir.clone();
        let dir2 = dir.clone();
        let t1 = std::thread::spawn(move || save_session_to_dir(&dir1, r#"{"who":"a"}"#));
        let t2 = std::thread::spawn(move || save_session_to_dir(&dir2, r#"{"who":"b"}"#));

        let r1 = t1.join().expect("thread1 panicked");
        let r2 = t2.join().expect("thread2 panicked");
        assert!(
            r1.is_ok() || r2.is_ok(),
            "both concurrent saves failed: r1={:?} r2={:?}",
            r1,
            r2
        );

        // 最終状態は torn write なしで「a」「b」いずれかの完全な内容でなければならない
        let loaded = load_session_from_dir(&dir).unwrap();
        assert!(
            loaded == r#"{"who":"a"}"# || loaded == r#"{"who":"b"}"#,
            "unexpected (possibly torn) content: {loaded}"
        );

        // 成功・失敗いずれのスレッドも自分の一意 temp を後始末するため残骸はない
        let leftovers = list_tmp_leftovers(&dir);
        assert!(leftovers.is_empty(), "tmp leftovers: {:?}", leftovers);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── CSV 永続化 (save_csv_to_path / csv_temp_file_path) ─────────────────

    fn temp_csv_dir(name: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let mut dir = std::env::temp_dir();
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        dir.push(format!("report_tool_csv_test_{}_{}_{}", std::process::id(), name, n));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("csv_dir 作成失敗");
        dir
    }

    /// 新規保存の内容が BOM + 本文と一致すること。
    #[test]
    fn save_csv_to_path_new_file_matches_bom_and_body() {
        let dir = temp_csv_dir("new");
        let path = dir.join("report.csv");
        save_csv_to_path(&path, "a,b\n1,2").unwrap();

        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF], "先頭3バイトがBOMでなければならない");
        assert_eq!(&bytes[3..], b"a,b\n1,2");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 既存ファイルへの再保存で内容が置き換わること。
    #[test]
    fn save_csv_to_path_overwrite_replaces_content() {
        let dir = temp_csv_dir("overwrite");
        let path = dir.join("report.csv");
        save_csv_to_path(&path, "old-content").unwrap();
        save_csv_to_path(&path, "new-content").unwrap();

        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[3..], b"new-content");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 保存成功後に temp ファイルが残っていないこと。
    #[test]
    fn save_csv_to_path_no_leftover_tmp_after_success() {
        let dir = temp_csv_dir("no_leftover");
        let path = dir.join("report.csv");
        save_csv_to_path(&path, "x").unwrap();

        let leftovers = list_tmp_leftovers(&dir);
        assert!(leftovers.is_empty(), "tmp leftovers: {:?}", leftovers);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// temp 書込段階で失敗した場合、rename には一切到達せず既存の final ファイルは
    /// 無傷のまま残ることを確認する（torn write 防止の間接検証）。
    ///
    /// csv_temp_file_path はプロセス内カウンタで一意名を生成するため実際に使われる
    /// temp パスをテストから正確に予測できない。save_csv_via_temp（temp_path 引数化版）
    /// を直接呼び、事前にディレクトリとして塞いだ確定パスを渡すことで
    /// std::fs::File::create を確実に失敗させる
    /// （save_template_failure_before_rename_leaves_existing_file_untouched と同じ
    /// 「temp パスをディレクトリにして書込みを失敗させる」手法）。
    #[test]
    fn save_csv_to_path_failure_before_rename_leaves_existing_file_untouched() {
        let dir = temp_csv_dir("failure_before_rename");
        let path = dir.join("report.csv");
        save_csv_to_path(&path, "original").unwrap();

        let temp_path = dir.join("blocked.csv.tmp");
        std::fs::create_dir_all(&temp_path).unwrap();

        let err = save_csv_via_temp(&path, "corrupted", &temp_path).unwrap_err();
        assert!(!err.is_empty());

        // rename まで到達していないため、既存の final ファイルは書き換わっていない
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[3..], b"original");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
