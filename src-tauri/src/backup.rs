use serde::{Deserialize, Serialize};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
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
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x00000100000001b3;

    let mut hash = FNV_OFFSET;
    for byte in file_path.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    format!("{hash:016x}")
}

fn legacy_path_hash(file_path: &str) -> String {
    use std::collections::hash_map::DefaultHasher;

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
    std::fs::create_dir_all(&dir).map_err(|e| format!("バックアップディレクトリ作成失敗: {e}"))?;
    Ok(dir)
}

fn backup_file_path(backup_dir: &PathBuf, file_path: &str) -> PathBuf {
    backup_dir.join(format!("{}.json", path_hash(file_path)))
}

fn legacy_backup_file_path(backup_dir: &PathBuf, file_path: &str) -> PathBuf {
    backup_dir.join(format!("{}.json", legacy_path_hash(file_path)))
}

fn backup_atomic_temp_file_path(path: &Path) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    path.with_extension(format!("json.{}.{}.tmp", std::process::id(), stamp))
}

fn write_backup_file_atomically(path: &Path, json_str: &str) -> Result<(), String> {
    use std::io::Write;

    let temp = backup_atomic_temp_file_path(path);
    let result = (|| -> Result<(), String> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| format!("バックアップ一時ファイル作成失敗: {e}"))?;
        file.write_all(json_str.as_bytes())
            .map_err(|e| format!("バックアップ一時ファイル書き込み失敗: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("バックアップ一時ファイル同期失敗: {e}"))?;
        drop(file);
        atomic_replace_file(&temp, path)
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

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
            "バックアップ atomic replace 失敗: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace_file(temp: &Path, target: &Path) -> Result<(), String> {
    std::fs::rename(temp, target).map_err(|e| format!("バックアップ atomic rename 失敗: {e}"))?;
    if let Some(parent) = target.parent() {
        if let Ok(dir) = std::fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    Ok(())
}

/// `clear_backup` の削除対象パス一覧を返す。
/// SECURITY: direct backup file path 経路は意図的に含めない。
/// Webview から `invoke('clear_backup', { filePath: '<backup_dir>/任意.json' })` で
/// backup_dir 内の他バックアップを削除できる脆弱性を防ぐため、
/// 元 PDF パスのハッシュ計算経由 (現行 hash + legacy hash) に限定する。
fn clear_backup_targets(backup_dir: &PathBuf, file_path: &str) -> Vec<PathBuf> {
    vec![
        backup_file_path(backup_dir, file_path),
        legacy_backup_file_path(backup_dir, file_path),
    ]
}

fn readable_backup_file_path(backup_dir: &PathBuf, file_path: &str) -> PathBuf {
    // SECURITY #63: direct backup file path 経路は意図的に除外する。
    // Webview から `invoke('load_backup', { filePath: '<backup_dir>/任意.json' })` で
    // 他バックアップ JSON が読み出される脆弱性 (#63) を防ぐため、
    // 元 PDF パスのハッシュ計算経由 (現行 hash + legacy hash) に限定する。
    // (clear_backup_targets と同じポリシー)
    let current = backup_file_path(backup_dir, file_path);
    if current.exists() {
        return current;
    }

    let legacy = legacy_backup_file_path(backup_dir, file_path);
    if legacy.exists() {
        legacy
    } else {
        current
    }
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

    let pages: serde_json::Value =
        serde_json::from_str(&pages_json).map_err(|e| format!("pages_json解析失敗: {e}"))?;

    let data = serde_json::json!({
        "version": 1,
        "timestamp": timestamp,
        "originalFilePath": file_path,
        "pages": pages
    });

    let json_str = serde_json::to_string(&data).map_err(|e| format!("JSON生成失敗: {e}"))?;

    tokio::task::spawn_blocking(move || {
        write_backup_file_atomically(&bpath, &json_str)?;
        let legacy_bpath = legacy_backup_file_path(&backup_dir, &file_path);
        if legacy_bpath != bpath && legacy_bpath.exists() {
            let _ = std::fs::remove_file(legacy_bpath);
        }
        Ok(())
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
                        backups.push(BackupInfo {
                            file_path,
                            timestamp,
                            backup_path,
                        });
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

    tokio::task::spawn_blocking(move || {
        for path in clear_backup_targets(&backup_dir, &file_path) {
            if path.exists() {
                std::fs::remove_file(&path).map_err(|e| format!("バックアップ削除失敗: {e}"))?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("スレッドエラー: {e}"))?
}

/// Read the contents of the backup file at `path` as a UTF-8 string.
///
/// This is the AppHandle-free read core extracted from `load_backup` so it can
/// be unit-tested without Tauri infrastructure.
pub(crate) fn read_backup_file(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("バックアップ読み込み失敗: {e}"))
}

/// バックアップファイルの内容をJSON文字列として読み込む。
#[tauri::command]
pub async fn load_backup(app: AppHandle, file_path: String) -> Result<String, String> {
    let backup_dir = get_backup_dir(&app)?;
    let bpath = readable_backup_file_path(&backup_dir, &file_path);

    tokio::task::spawn_blocking(move || read_backup_file(&bpath))
        .await
        .map_err(|e| format!("スレッドエラー: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::{
        backup_file_path, clear_backup_targets, legacy_backup_file_path, legacy_path_hash,
        path_hash, read_backup_file, write_backup_file_atomically,
    };
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn path_hash_uses_fixed_fnv1a_64() {
        assert_eq!(path_hash(""), "cbf29ce484222325");
        assert_eq!(path_hash("C:\\docs\\sample.pdf"), "9003f252672f1593");
    }

    /// テスト用の一意な backup_dir を作成して返す。
    /// `tempfile` クレートを増やさないため std::env::temp_dir + プロセス内カウンタで衝突回避する。
    fn make_backup_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let mut dir = std::env::temp_dir();
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        dir.push(format!(
            "pecotool_backup_test_{}_{}_{}",
            std::process::id(),
            tag,
            n
        ));
        // 前回の残骸があれば掃除
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("backup_dir 作成失敗");
        // canonicalize しておくと clear_backup_targets が返すパスと比較しやすい
        dir.canonicalize().unwrap_or(dir)
    }

    #[test]
    fn write_backup_file_atomically_replaces_existing_json() {
        let backup_dir = make_backup_dir("atomic");
        let bpath = backup_file_path(&backup_dir, "C:\\docs\\atomic.pdf");

        write_backup_file_atomically(&bpath, "{\"first\":true}").unwrap();
        write_backup_file_atomically(&bpath, "{\"second\":true}").unwrap();

        let content = std::fs::read_to_string(&bpath).unwrap();
        assert_eq!(content, "{\"second\":true}");

        let leftovers: Vec<_> = std::fs::read_dir(&backup_dir)
            .unwrap()
            .flatten()
            .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("tmp"))
            .collect();
        assert!(leftovers.is_empty(), "tmp leftovers: {:?}", leftovers);

        let _ = std::fs::remove_dir_all(&backup_dir);
    }

    /// clear_backup_targets には direct path 経路が含まれないことを確認する。
    ///
    /// 攻撃シナリオ:
    /// Webview から `invoke('clear_backup', { filePath: '<backup_dir>/<他人のハッシュ>.json' })`
    /// を実行しても、その絶対 JSON パス自体は削除対象に含まれない。
    /// (ハッシュ計算結果はランダムな別名となり、被害ファイルとは一致しない)
    #[test]
    fn clear_backup_targets_rejects_direct_backup_dir_json_path() {
        let backup_dir = make_backup_dir("direct_reject");

        // 別ユーザー (=別 PDF パス) のバックアップを backup_dir 内に作成
        let victim_pdf = "C:\\victim\\confidential.pdf";
        let victim_backup = backup_file_path(&backup_dir, victim_pdf);
        std::fs::write(&victim_backup, b"{\"victim\":true}").unwrap();
        assert!(victim_backup.exists(), "前提: victim バックアップが存在");

        // 攻撃者は victim_backup の絶対パス (.json) を file_path として渡す
        let attacker_payload = victim_backup.to_string_lossy().to_string();
        let targets = clear_backup_targets(&backup_dir, &attacker_payload);

        // 削除対象に victim_backup そのものは含まれない (direct path 経路の廃止)
        assert!(
            !targets.iter().any(|p| p == &victim_backup),
            "direct path 経路が残存している: targets={:?}, victim={:?}",
            targets,
            victim_backup
        );

        // 念のため: 攻撃者の payload 文字列を PDF パスとして hash 化した結果も victim と一致しない
        // (= 攻撃者は他人のバックアップを誤削除できない)
        let attacker_hash_target = backup_file_path(&backup_dir, &attacker_payload);
        assert_ne!(attacker_hash_target, victim_backup);

        // 後片付け
        let _ = std::fs::remove_file(&victim_backup);
        let _ = std::fs::remove_dir_all(&backup_dir);
    }

    /// 正規パス (PDF ファイルパス) からの削除対象計算は引き続き
    /// 現行 hash と legacy hash の 2 件を返すことを確認する。
    #[test]
    fn clear_backup_targets_returns_current_and_legacy_hash_paths() {
        let backup_dir = make_backup_dir("normal");
        let pdf_path = "C:\\docs\\sample.pdf";

        let targets = clear_backup_targets(&backup_dir, pdf_path);

        let expected_current = backup_file_path(&backup_dir, pdf_path);
        let expected_legacy = legacy_backup_file_path(&backup_dir, pdf_path);

        assert_eq!(targets.len(), 2, "削除対象は current + legacy の 2 件");
        assert!(targets.contains(&expected_current));
        assert!(targets.contains(&expected_legacy));

        // current 側は FNV-1a 固定値: path_hash の単体テストと整合
        let expected_name = format!("{}.json", path_hash(pdf_path));
        assert_eq!(
            expected_current.file_name().and_then(|s| s.to_str()),
            Some(expected_name.as_str())
        );
        // legacy 側も legacy_path_hash 経由のファイル名であること
        let expected_legacy_name = format!("{}.json", legacy_path_hash(pdf_path));
        assert_eq!(
            expected_legacy.file_name().and_then(|s| s.to_str()),
            Some(expected_legacy_name.as_str())
        );

        let _ = std::fs::remove_dir_all(&backup_dir);
    }

    /// 正規パス経由で実際にファイル削除が機能することを確認する
    /// (clear_backup_targets を使って `clear_backup` の closure 相当を再現)。
    #[test]
    fn clear_backup_targets_actually_deletes_existing_backup() {
        let backup_dir = make_backup_dir("delete_ok");
        let pdf_path = "C:\\docs\\to_delete.pdf";

        let bpath = backup_file_path(&backup_dir, pdf_path);
        std::fs::write(&bpath, b"{\"ok\":1}").unwrap();
        assert!(bpath.exists());

        // clear_backup 内 closure と同じロジック
        for path in clear_backup_targets(&backup_dir, pdf_path) {
            if path.exists() {
                std::fs::remove_file(&path).unwrap();
            }
        }

        assert!(!bpath.exists(), "正規パス経由の削除は動作する");
        let _ = std::fs::remove_dir_all(&backup_dir);
    }

    // ── save_backup / load_backup roundtrip (AppHandle-free) ─────────────

    /// 書いた JSON 文字列を read_backup_file で読み戻して一致すること。
    #[test]
    fn backup_roundtrip_written_content_matches() {
        let backup_dir = make_backup_dir("roundtrip_read");
        let bpath = backup_file_path(&backup_dir, "C:\\docs\\sample.pdf");
        let json = r#"{"version":1,"timestamp":"2026-06-04T00:00:00Z","originalFilePath":"C:\\docs\\sample.pdf","pages":[]}"#;

        write_backup_file_atomically(&bpath, json).unwrap();

        let read_back = read_backup_file(&bpath).unwrap();
        assert_eq!(read_back, json, "read-back content must match what was written");

        let _ = std::fs::remove_dir_all(&backup_dir);
    }

    /// write_backup_file_atomically で上書きした後、最新内容だけが読める（古い内容が残らない）。
    #[test]
    fn backup_roundtrip_overwrite_returns_latest_content() {
        let backup_dir = make_backup_dir("roundtrip_overwrite");
        let bpath = backup_file_path(&backup_dir, "C:\\docs\\overwrite.pdf");

        let first = r#"{"version":1,"timestamp":"T1","pages":["p1","p2","p3","p4","p5"]}"#;
        let second = r#"{"version":1,"timestamp":"T2","pages":[]}"#;

        // first は second より長い; 上書き後に first の残骸が残ってはいけない
        write_backup_file_atomically(&bpath, first).unwrap();
        write_backup_file_atomically(&bpath, second).unwrap();

        let read_back = read_backup_file(&bpath).unwrap();
        assert_eq!(read_back, second, "after overwrite, only latest content must be readable");
        assert!(
            !read_back.contains("p1"),
            "stale content from first write must not appear: {read_back}"
        );

        let _ = std::fs::remove_dir_all(&backup_dir);
    }

    /// 存在しないパスを read_backup_file に渡すとエラーが返ること。
    #[test]
    fn backup_read_nonexistent_returns_error() {
        let backup_dir = make_backup_dir("roundtrip_missing");
        let bpath = backup_dir.join("nonexistent.json");

        let err = read_backup_file(&bpath).unwrap_err();
        assert!(
            err.contains("バックアップ読み込み失敗"),
            "error must mention read failure, got: {err}"
        );

        let _ = std::fs::remove_dir_all(&backup_dir);
    }
}
