use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BackupInfo {
    pub file_path: String,
    pub timestamp: String,
    pub backup_path: String,
}

/// ファイルパスをハッシュ化してバックアップファイル名を生成する。
/// ロングパスや特殊文字の問題を回避するため、パス文字列をそのままファイル名に使わない。
fn path_hash(file_path: &str) -> String {
    let mut hasher = DefaultHasher::new();
    file_path.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn get_backup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir取得失敗: {e}"))?;
    dir.push("backups");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("バックアップディレクトリ作成失敗: {e}"))?;
    Ok(dir)
}

fn backup_file_path(backup_dir: &PathBuf, file_path: &str) -> PathBuf {
    backup_dir.join(format!("{}.json", path_hash(file_path)))
}

/// バックアップデータをディスクに書き込む。
/// フロントエンドからダーティページのJSONを受け取り、バックアップファイルとして保存する。
/// Tokio spawn_blocking により UI スレッドをブロックしない。
#[tauri::command]
pub async fn save_backup(
    app: AppHandle,
    file_path: String,
    timestamp: String,
    pages_json: String,
) -> Result<(), String> {
    let backup_dir = get_backup_dir(&app)?;
    let bpath = backup_file_path(&backup_dir, &file_path);

    let pages: serde_json::Value = serde_json::from_str(&pages_json)
        .map_err(|e| format!("pages_json解析失敗: {e}"))?;

    let data = serde_json::json!({
        "version": 1,
        "timestamp": timestamp,
        "originalFilePath": file_path,
        "pages": pages
    });

    let json_str = serde_json::to_string(&data)
        .map_err(|e| format!("JSON生成失敗: {e}"))?;

    tokio::task::spawn_blocking(move || {
        std::fs::write(&bpath, json_str)
            .map_err(|e| format!("バックアップ書き込み失敗: {e}"))
    })
    .await
    .map_err(|e| format!("スレッドエラー: {e}"))?
}

/// 起動時にバックアップディレクトリをスキャンし、未処理のバックアップ一覧を返す。
#[tauri::command]
pub async fn check_pending_backups(app: AppHandle) -> Result<Vec<BackupInfo>, String> {
    let backup_dir = get_backup_dir(&app)?;

    tokio::task::spawn_blocking(move || -> Result<Vec<BackupInfo>, String> {
        let mut backups = Vec::new();

        let entries = match std::fs::read_dir(&backup_dir) {
            Ok(e) => e,
            Err(_) => return Ok(backups),
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(data) = serde_json::from_str::<serde_json::Value>(&content) {
                    let file_path = data["originalFilePath"].as_str().unwrap_or("").to_string();
                    let timestamp = data["timestamp"].as_str().unwrap_or("").to_string();
                    let backup_path = path.to_string_lossy().to_string();
                    if !file_path.is_empty() {
                        backups.push(BackupInfo { file_path, timestamp, backup_path });
                    }
                }
            }
        }

        Ok(backups)
    })
    .await
    .map_err(|e| format!("スレッドエラー: {e}"))?
}

/// 正常保存後にバックアップファイルを削除する。
#[tauri::command]
pub async fn clear_backup(app: AppHandle, file_path: String) -> Result<(), String> {
    let backup_dir = get_backup_dir(&app)?;
    let bpath = backup_file_path(&backup_dir, &file_path);

    tokio::task::spawn_blocking(move || {
        if bpath.exists() {
            std::fs::remove_file(&bpath)
                .map_err(|e| format!("バックアップ削除失敗: {e}"))
        } else {
            Ok(())
        }
    })
    .await
    .map_err(|e| format!("スレッドエラー: {e}"))?
}

/// バックアップファイルの内容をJSON文字列として読み込む。
#[tauri::command]
pub async fn load_backup(app: AppHandle, file_path: String) -> Result<String, String> {
    let backup_dir = get_backup_dir(&app)?;
    let bpath = backup_file_path(&backup_dir, &file_path);

    tokio::task::spawn_blocking(move || {
        std::fs::read_to_string(&bpath)
            .map_err(|e| format!("バックアップ読み込み失敗: {e}"))
    })
    .await
    .map_err(|e| format!("スレッドエラー: {e}"))?
}
