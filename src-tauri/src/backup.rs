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
        // PCT-119: 掃除失敗を握りつぶさず可視化する（動作自体は継続=fail-open のまま）。
        if let Err(cleanup_err) = std::fs::remove_file(&temp) {
            eprintln!(
                "[backup] failed to remove temp file after write error: {} ({cleanup_err})",
                temp.display()
            );
        }
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

/// `check_pending_backups` が復元ダイアログへ表示する originalFilePath の健全性を検証する。
///
/// SECURITY (PCT-119): backups/ 配下の JSON はハッシュ命名で書込/読込経路こそ閉じているが、
/// ファイル自体はディスク上の平文であり、外部から差し替えられる前提を置く必要がある。
/// 細工された originalFilePath（空文字・相対パス・非 PDF 拡張子・異常に長い文字列）を
/// 無検証のまま `unwrap_or("")` で通すと、復元ダイアログに任意文字列を表示できてしまい
/// パス偽装によるユーザー誤誘導の余地になる。無効な場合はエントリごと一覧から除外する
/// （表示だけを誤魔化す方向ではなく、疑わしいバックアップそのものを見せない）。
fn is_valid_backup_original_path(file_path: &str) -> bool {
    const MAX_PATH_LEN: usize = 4096;
    if file_path.is_empty() || file_path.len() > MAX_PATH_LEN {
        return false;
    }
    let path = Path::new(file_path);
    if !path.is_absolute() {
        return false;
    }
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
}

/// 保存直後にバックアップ削除 (`clear_backup`) が失敗した場合の残骸 (#364 / PCT-141 実害①) を
/// 検出するための猶予幅。
///
/// マージンを設ける理由:
/// - 自動バックアップは quiet period 60秒・既定 interval 5分で動くため、バックアップ取得後に
///   実際の保存が完了するまで通常は数十秒〜分オーダーの間隔が空く。したがって
///   「バックアップ直後 (数秒以内) に完了した保存」を stale と誤判定しても実害は乏しい一方、
///   マージンを設けないと FAT 系ファイルシステムの mtime 粒度 (2秒単位) やディスク書込み
///   バッファのフラッシュタイミングのわずかなブレで、本物の未保存バックアップを誤って
///   stale 扱いしてしまう恐れがある。
/// - 偽陽性 (本物の未保存バックアップを隠す) は不可、偽陰性 (提案しすぎ) は許容という方針
///   (Issue #364 実害①) のもと安全側に倒すため、上記ノイズを十分吸収できる 5 秒とした。
const STALE_MTIME_MARGIN: std::time::Duration = std::time::Duration::from_secs(5);

/// 指定パスのファイルサイズ（バイト数）を取得する。取得に失敗した場合は `None`。
///
/// `save_backup` がバックアップ取得時点の元 PDF サイズを記録するため、および
/// `is_backup_stale` が現在の元 PDF サイズを取得するために使う。
fn stat_file_size(path: &str) -> Option<u64> {
    std::fs::metadata(path).ok().map(|m| m.len())
}

/// バックアップが「既に保存済みで残骸化した」= stale かどうかを判定する。
///
/// 判定方法:
/// 1. バックアップ JSON ファイル自体の mtime を「バックアップ取得時刻」の代理として使い、
///    元 PDF の現在の mtime と比較する。JSON 内の `timestamp` (JS 側 `Date.now()` 由来の ISO 文字列)
///    はパースに追加クレートが要るため使わず、OS のファイルシステムメタデータのみで完結させる
///    (`write_backup_file_atomically` は atomic replace 直後に mtime が確定するため、
///    JS 側の timestamp とはほぼ同時刻になる)。
/// 2. `original_size_at_backup`（バックアップ取得時点の元 PDF サイズ、`save_backup` が
///    記録する）が渡された場合は、現在の PDF サイズと比較し、サイズが変化していることも
///    追加で要求する（mtime 新しい かつ size 変化、の二重条件）。
///
/// 二重条件にした理由 (らでん監査指摘): 別 PC 間のファイル同期ツールが、内容を変えずに
/// mtime だけを更新するケースがある。mtime のみの判定だとこれを「保存完走」と誤認し、
/// 本物の未保存バックアップを stale として隠してしまう (偽陽性 = 不可、Issue #364 実害①の
/// 方針に抵触)。サイズ変化も要求すれば、内容不変の mtime タッチだけでは stale 判定されない。
///
/// `original_size_at_backup` が `None`（旧バックアップに size フィールドが無い場合）は
/// 従来どおり mtime のみで判定する（後方互換・スキーマ非破壊）。
///
/// 判定不能な場合 (PDF が見つからない・メタデータ取得失敗等) は必ず `false` を返し、
/// 従来どおり復元候補として提案する (安全側優先)。
fn is_backup_stale(
    backup_path: &Path,
    pdf_file_path: &str,
    original_size_at_backup: Option<u64>,
) -> bool {
    let backup_mtime = match std::fs::metadata(backup_path).and_then(|m| m.modified()) {
        Ok(t) => t,
        Err(_) => return false,
    };
    let pdf_metadata = match std::fs::metadata(pdf_file_path) {
        Ok(m) => m,
        Err(_) => return false,
    };
    let pdf_mtime = match pdf_metadata.modified() {
        Ok(t) => t,
        Err(_) => return false,
    };

    let mtime_stale_candidate = match pdf_mtime.duration_since(backup_mtime) {
        // PDF mtime がバックアップ mtime よりマージン以上新しい
        // = バックアップ取得後に保存が完走した可能性が高い → stale 候補
        Ok(delta) => delta >= STALE_MTIME_MARGIN,
        // PDF mtime <= backup mtime (クロックスキューで逆転した場合を含む) → stale ではない
        Err(_) => false,
    };
    if !mtime_stale_candidate {
        return false;
    }

    match original_size_at_backup {
        // size 情報がある場合: サイズが変化していなければ (同期ツールの mtime タッチ等)
        // stale と判定しない。変化していれば stale。
        Some(original_size) => pdf_metadata.len() != original_size,
        // 旧バックアップ (size フィールド無し): 従来どおり mtime のみで判定する。
        None => true,
    }
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

    // stale 判定強化 (らでん監査指摘): バックアップ取得時点の元 PDF サイズを記録する。
    // 取得失敗時 (PDF が一時的にロック中等) は null のままとし、is_backup_stale 側で
    // 従来どおり mtime のみの判定にフォールバックする (後方互換)。
    let original_size_at_backup = stat_file_size(&file_path);

    let data = serde_json::json!({
        "version": 1,
        "timestamp": timestamp,
        "originalFilePath": file_path,
        "originalSizeAtBackup": original_size_at_backup,
        "pages": pages
    });

    let json_str = serde_json::to_string(&data).map_err(|e| format!("JSON生成失敗: {e}"))?;

    tokio::task::spawn_blocking(move || {
        write_backup_file_atomically(&bpath, &json_str)?;
        let legacy_bpath = legacy_backup_file_path(&backup_dir, &file_path);
        if legacy_bpath != bpath && legacy_bpath.exists() {
            // PCT-119: 掃除失敗を握りつぶさず可視化する（動作自体は継続=fail-open のまま）。
            if let Err(e) = std::fs::remove_file(&legacy_bpath) {
                eprintln!(
                    "[backup] failed to remove legacy backup file: {} ({e})",
                    legacy_bpath.display()
                );
            }
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
                    let original_size_at_backup = data["originalSizeAtBackup"].as_u64();
                    // #364 / PCT-141 実害①: clear_backup が2回とも失敗した場合の残骸バックアップが
                    // 「偽の未保存提案」を出すのを防ぐため、PDF の方が新しければ一覧から除外する。
                    // らでん監査指摘: mtime に加えてサイズ変化も要求し、同期ツールの mtime タッチ
                    // だけで本物の未保存バックアップを隠さないようにする (is_backup_stale 参照)。
                    if is_valid_backup_original_path(&file_path)
                        && !is_backup_stale(&path, &file_path, original_size_at_backup)
                    {
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
        backup_file_path, clear_backup_targets, is_backup_stale, is_valid_backup_original_path,
        legacy_backup_file_path, legacy_path_hash, path_hash, read_backup_file, stat_file_size,
        write_backup_file_atomically, STALE_MTIME_MARGIN,
    };
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, SystemTime};

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

    // ── PCT-119: is_valid_backup_original_path (check_pending_backups の表示前検証) ──

    /// 空文字は拒否される（細工 JSON で originalFilePath が欠落/空の場合）。
    #[test]
    fn is_valid_backup_original_path_rejects_empty() {
        assert!(!is_valid_backup_original_path(""));
    }

    /// 相対パスは拒否される。
    #[test]
    fn is_valid_backup_original_path_rejects_relative_path() {
        assert!(!is_valid_backup_original_path("docs\\sample.pdf"));
        assert!(!is_valid_backup_original_path("../../etc/sample.pdf"));
    }

    /// .pdf 以外の拡張子は拒否される。
    #[test]
    fn is_valid_backup_original_path_rejects_non_pdf_extension() {
        assert!(!is_valid_backup_original_path("C:\\docs\\sample.txt"));
        assert!(!is_valid_backup_original_path("C:\\docs\\sample"));
    }

    /// 異常に長い文字列は拒否される（サイズ上限ガード）。
    #[test]
    fn is_valid_backup_original_path_rejects_oversized_path() {
        let huge = format!("C:\\{}\\sample.pdf", "a".repeat(5000));
        assert!(!is_valid_backup_original_path(&huge));
    }

    /// 正規の絶対 PDF パス（大文字拡張子含む）は許可される。
    #[test]
    fn is_valid_backup_original_path_accepts_normal_absolute_pdf_path() {
        assert!(is_valid_backup_original_path("C:\\docs\\sample.pdf"));
        assert!(is_valid_backup_original_path("C:\\docs\\SAMPLE.PDF"));
    }

    /// check_pending_backups と同じフィルタ条件で、originalFilePath が欠落した
    /// 細工 JSON がバックアップ一覧から除外されること（unwrap_or("") 経路の回帰）。
    #[test]
    fn check_pending_backups_filter_excludes_missing_original_file_path() {
        let data: serde_json::Value =
            serde_json::from_str(r#"{"version":1,"timestamp":"T1","pages":[]}"#).unwrap();
        let file_path = data["originalFilePath"].as_str().unwrap_or("").to_string();
        assert_eq!(file_path, "", "欠落時は空文字にフォールバックする（従来仕様）");
        assert!(
            !is_valid_backup_original_path(&file_path),
            "空文字は check_pending_backups の一覧に含めてはいけない"
        );
    }

    // ── #364 / PCT-141: is_backup_stale (check_pending_backups の残骸バックアップ除外) ──

    /// テスト用の一意なファイルパスを作り、指定 mtime で書き込む。
    fn write_file_with_mtime(dir: &PathBuf, name: &str, mtime: SystemTime) -> PathBuf {
        use std::fs::File;
        let path = dir.join(name);
        let file = File::create(&path).expect("test file 作成失敗");
        file.set_modified(mtime).expect("test file mtime 設定失敗");
        path
    }

    /// PDF の mtime がバックアップよりマージンを超えて新しい場合、stale として判定される
    /// (= 保存が完走した後に clear_backup が失敗して残った残骸とみなす)。
    #[test]
    fn is_backup_stale_true_when_pdf_newer_than_margin() {
        let dir = make_backup_dir("stale_excluded");
        let backup_time = SystemTime::now();
        let pdf_time = backup_time + STALE_MTIME_MARGIN + Duration::from_secs(1);

        let backup_path = write_file_with_mtime(&dir, "backup.json", backup_time);
        let pdf_path = write_file_with_mtime(&dir, "original.pdf", pdf_time);

        assert!(
            is_backup_stale(&backup_path, &pdf_path.to_string_lossy(), None),
            "PDF がバックアップよりマージン超で新しい場合は stale と判定すべき"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// PDF がバックアップより古い（=まだ保存されていない本物の未保存バックアップ）場合、
    /// stale と判定されず一覧に残る。
    #[test]
    fn is_backup_stale_false_when_pdf_older_than_backup() {
        let dir = make_backup_dir("stale_kept_older_pdf");
        let backup_time = SystemTime::now();
        let pdf_time = backup_time - Duration::from_secs(3600);

        let backup_path = write_file_with_mtime(&dir, "backup.json", backup_time);
        let pdf_path = write_file_with_mtime(&dir, "original.pdf", pdf_time);

        assert!(
            !is_backup_stale(&backup_path, &pdf_path.to_string_lossy(), None),
            "PDF がバックアップより古い＝本物の未保存バックアップは残すべき"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 元 PDF が存在しない（削除・移動済み）場合は判定不能として stale 扱いしない
    /// (安全側優先: 偽陽性＝本物のバックアップを隠すのは不可)。
    #[test]
    fn is_backup_stale_false_when_pdf_missing() {
        let dir = make_backup_dir("stale_pdf_missing");
        let backup_path = write_file_with_mtime(&dir, "backup.json", SystemTime::now());
        let missing_pdf = dir.join("does_not_exist.pdf");

        assert!(
            !is_backup_stale(&backup_path, &missing_pdf.to_string_lossy(), None),
            "PDF 消失時は判定不能として従来どおり提案すべき"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// バックアップ自体のファイルが読めない（想定外の削除競合等）場合も判定不能として
    /// stale 扱いしない。
    #[test]
    fn is_backup_stale_false_when_backup_file_missing() {
        let dir = make_backup_dir("stale_backup_missing");
        let pdf_path = write_file_with_mtime(&dir, "original.pdf", SystemTime::now());
        let missing_backup = dir.join("does_not_exist.json");

        assert!(
            !is_backup_stale(&missing_backup, &pdf_path.to_string_lossy(), None),
            "バックアップ自体が読めない場合も判定不能として従来どおり提案すべき"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 境界値: PDF がバックアップよりマージン未満しか新しくない場合は stale としない
    /// (クロックスキュー/mtime 粒度ノイズの吸収対象)。
    #[test]
    fn is_backup_stale_false_at_margin_boundary_just_under() {
        let dir = make_backup_dir("stale_margin_under");
        let backup_time = SystemTime::now();
        // マージンちょうど未満 (1秒手前)
        let pdf_time = backup_time + STALE_MTIME_MARGIN - Duration::from_secs(1);

        let backup_path = write_file_with_mtime(&dir, "backup.json", backup_time);
        let pdf_path = write_file_with_mtime(&dir, "original.pdf", pdf_time);

        assert!(
            !is_backup_stale(&backup_path, &pdf_path.to_string_lossy(), None),
            "マージン未満のずれは stale と判定してはいけない"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 境界値: PDF がバックアップよりちょうどマージン分だけ新しい場合は stale
    /// (`>=` 判定であることの固定)。
    #[test]
    fn is_backup_stale_true_at_margin_boundary_exact() {
        let dir = make_backup_dir("stale_margin_exact");
        let backup_time = SystemTime::now();
        let pdf_time = backup_time + STALE_MTIME_MARGIN;

        let backup_path = write_file_with_mtime(&dir, "backup.json", backup_time);
        let pdf_path = write_file_with_mtime(&dir, "original.pdf", pdf_time);

        assert!(
            is_backup_stale(&backup_path, &pdf_path.to_string_lossy(), None),
            "マージンちょうどのずれは stale と判定すべき (>= 境界)"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// PDF とバックアップの mtime が完全一致する場合は stale としない
    /// (duration_since(Ok(ZERO)) は margin 未満なので false)。
    #[test]
    fn is_backup_stale_false_when_mtimes_equal() {
        let dir = make_backup_dir("stale_mtimes_equal");
        let same_time = SystemTime::now();

        let backup_path = write_file_with_mtime(&dir, "backup.json", same_time);
        let pdf_path = write_file_with_mtime(&dir, "original.pdf", same_time);

        assert!(
            !is_backup_stale(&backup_path, &pdf_path.to_string_lossy(), None),
            "mtime が完全一致する場合は stale と判定してはいけない"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// サイズ比較テスト用: 指定バイト数の内容を持つファイルを作り、mtime を設定して返す。
    fn write_file_with_mtime_and_size(
        dir: &PathBuf,
        name: &str,
        mtime: SystemTime,
        size: usize,
    ) -> PathBuf {
        use std::fs::File;
        use std::io::Write;
        let path = dir.join(name);
        let mut file = File::create(&path).expect("test file 作成失敗");
        file.write_all(&vec![b'x'; size]).expect("test file 書き込み失敗");
        file.set_modified(mtime).expect("test file mtime 設定失敗");
        path
    }

    // ── stat_file_size (らでん監査指摘: stale 判定強化用ヘルパ) ──────────────────

    #[test]
    fn stat_file_size_returns_size_for_existing_file() {
        let dir = make_backup_dir("stat_size_ok");
        let path = write_file_with_mtime_and_size(&dir, "sized.pdf", SystemTime::now(), 42);

        assert_eq!(stat_file_size(&path.to_string_lossy()), Some(42));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stat_file_size_returns_none_for_missing_file() {
        let dir = make_backup_dir("stat_size_missing");
        let missing = dir.join("does_not_exist.pdf");

        assert_eq!(stat_file_size(&missing.to_string_lossy()), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── is_backup_stale: サイズ二重条件 (らでん監査指摘・多PC同期ハザード対策) ─────
    //
    // 別PC間のファイル同期ツールが内容を変えずに mtime だけ更新するケースがあり、
    // mtime のみの判定では本物の未保存バックアップを stale と誤判定してしまう
    // (偽陽性 = 不可)。サイズ変化も要求することでこれを防ぐ。

    /// mtime はマージン超で新しいが、サイズが変化していない場合
    /// (同期ツールが内容不変のまま mtime だけ更新したケースを模擬) は
    /// stale と判定しない。
    #[test]
    fn is_backup_stale_false_when_mtime_newer_but_size_unchanged() {
        let dir = make_backup_dir("stale_size_unchanged");
        let backup_time = SystemTime::now();
        let pdf_time = backup_time + STALE_MTIME_MARGIN + Duration::from_secs(1);

        let backup_path = write_file_with_mtime(&dir, "backup.json", backup_time);
        // サイズ 100 バイトで統一 (mtime だけ新しい = 同期ツールのタッチを模擬)
        let pdf_path = write_file_with_mtime_and_size(&dir, "original.pdf", pdf_time, 100);

        assert!(
            !is_backup_stale(&backup_path, &pdf_path.to_string_lossy(), Some(100)),
            "mtime のみ新しくサイズ不変の場合は stale と判定してはいけない (同期ツール誤検知対策)"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// mtime がマージン超で新しく、かつサイズも変化している場合は stale と判定する
    /// (実際に保存が完走したケース)。
    #[test]
    fn is_backup_stale_true_when_mtime_newer_and_size_changed() {
        let dir = make_backup_dir("stale_size_changed");
        let backup_time = SystemTime::now();
        let pdf_time = backup_time + STALE_MTIME_MARGIN + Duration::from_secs(1);

        let backup_path = write_file_with_mtime(&dir, "backup.json", backup_time);
        let pdf_path = write_file_with_mtime_and_size(&dir, "original.pdf", pdf_time, 200);

        assert!(
            is_backup_stale(&backup_path, &pdf_path.to_string_lossy(), Some(100)),
            "mtime 新しくサイズも変化した場合は stale と判定すべき"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// サイズ情報が渡されていても、mtime がマージン未満なら (そもそも stale 候補にならない)
    /// サイズに関わらず stale と判定しない。
    #[test]
    fn is_backup_stale_false_when_size_changed_but_mtime_not_new_enough() {
        let dir = make_backup_dir("stale_size_but_mtime_recent");
        let backup_time = SystemTime::now();
        // マージン未満
        let pdf_time = backup_time + STALE_MTIME_MARGIN - Duration::from_secs(1);

        let backup_path = write_file_with_mtime(&dir, "backup.json", backup_time);
        let pdf_path = write_file_with_mtime_and_size(&dir, "original.pdf", pdf_time, 200);

        assert!(
            !is_backup_stale(&backup_path, &pdf_path.to_string_lossy(), Some(100)),
            "mtime がマージン未満ならサイズが変化していても stale と判定してはいけない"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 後方互換: `original_size_at_backup=None` (旧バックアップ・size フィールド無し) の場合は
    /// 従来どおり mtime のみで stale 判定する。
    #[test]
    fn is_backup_stale_legacy_none_size_uses_mtime_only() {
        let dir = make_backup_dir("stale_legacy_none_size");
        let backup_time = SystemTime::now();
        let pdf_time = backup_time + STALE_MTIME_MARGIN + Duration::from_secs(1);

        let backup_path = write_file_with_mtime(&dir, "backup.json", backup_time);
        let pdf_path = write_file_with_mtime(&dir, "original.pdf", pdf_time);

        assert!(
            is_backup_stale(&backup_path, &pdf_path.to_string_lossy(), None),
            "size フィールドが無い旧バックアップは mtime のみで stale 判定すべき (後方互換)"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
