use std::time::Duration;
use tauri::Manager;

#[tauri::command]
async fn run_ocr(
    app: tauri::AppHandle,
    image_path: String,
    page_width: f64,
    page_height: f64,
    render_scale: f64,
) -> Result<String, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("リソースディレクトリの取得に失敗: {}", e))?;

    let exe_path = resource_dir.join("ocr_engine").join("ocr_engine.exe");
    let model_dir = resource_dir.join("ocr_engine").join("models");

    if !exe_path.exists() {
        return Err("OCRエンジンが見つかりません".to_string());
    }

    let run = async {
        tokio::process::Command::new(&exe_path)
            .args([
                "--input",
                &image_path,
                "--model-dir",
                &model_dir.to_string_lossy(),
                "--page-width",
                &page_width.to_string(),
                "--page-height",
                &page_height.to_string(),
                "--render-scale",
                &render_scale.to_string(),
            ])
            .output()
            .await
            .map_err(|e| format!("サイドカー起動失敗: {}", e))
    };

    let output = tokio::time::timeout(Duration::from_secs(120), run)
        .await
        .map_err(|_| "OCR処理がタイムアウトしました".to_string())??;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("OCRエンジンがエラーで終了しました: {}", stderr));
    }

    let stdout = String::from_utf8(output.stdout)
        .map_err(|e| format!("stdout のデコードに失敗: {}", e))?;

    if stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("OCRエンジンの出力が空です。stderr: {}", stderr));
    }

    Ok(stdout)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![run_ocr])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
