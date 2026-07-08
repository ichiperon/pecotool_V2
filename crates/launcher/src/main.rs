// Peco 統合ランチャー。
//
// 外ヅラは1アイコンに統合し、起動時の Ctrl 押下で起動先を分岐する:
//   - 通常ダブルクリック   -> 本体 PecoTool (Peco.exe)
//   - Ctrl+ダブルクリック  -> 帳票ツール (PecoReportTool.exe)
//
// 中身は別プロセス・別コードベースで、本体には一切手を入れない。
// 起動直後に Ctrl の押下状態を読む手法は Office のセーフモード起動と同じ。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::Command;

use windows::core::PCWSTR;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL};
use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

// 起動先の解決は2段構え（計画書 R5 — Tauri NSIS 生成スクリプトの実測で確定・2026-07-08）:
//   1. ランチャー隣接（ポータブル配置・統合インストーラが /D= で誘導した場合）
//   2. Tauri NSIS 既定のインストール先（installMode=currentUser・両アプリとも既定）
//        %LOCALAPPDATA%\Peco\Peco.exe
//        %LOCALAPPDATA%\PecoReportTool\PecoReportTool.exe
//      ※ 帳票ツールの exe 名は tauri.conf.json の mainBinaryName で PecoReportTool.exe に
//        統一済み（未指定だと crate 名由来の report-tool.exe になる）。
const MAIN_APP_REL: &str = "Peco.exe";
const REPORT_APP_REL: &str = "report-tool/PecoReportTool.exe";
const MAIN_APP_INSTALLED: &str = "Peco/Peco.exe";
const REPORT_APP_INSTALLED: &str = "PecoReportTool/PecoReportTool.exe";

/// 起動直後の Ctrl キー押下状態を返す。GetAsyncKeyState の最上位ビットが押下を表す。
fn ctrl_held() -> bool {
    unsafe { (GetAsyncKeyState(VK_CONTROL.0 as i32) as u16) & 0x8000 != 0 }
}

/// 起動対象 exe の絶対パスを解決する。
///
/// ランチャー隣接（ポータブル/統合インストーラ配置）を優先し、無ければ
/// %LOCALAPPDATA% 配下の Tauri NSIS 既定インストール先へフォールバックする。
/// どちらにも実在しない場合は隣接パスを返し、spawn 失敗時の MessageBox で
/// パス込みのエラーが可視化される（無反応事故の防止は main 側の既存機構）。
fn resolve_target(base_dir: &PathBuf, local_app_data: Option<PathBuf>, ctrl: bool) -> PathBuf {
    let portable = base_dir.join(if ctrl { REPORT_APP_REL } else { MAIN_APP_REL });
    if portable.is_file() {
        return portable;
    }
    // PCT-199 AQ-5 の不変条件「相対パスを Command::new に渡さない」を env 由来経路でも守る:
    // LOCALAPPDATA が空文字/相対パスだと join 結果が相対になり、is_file() の CWD 基準判定を
    // すり抜けて相対パス起動（binary planting の表層）が復活する。絶対パスのみ受け付ける。
    if let Some(lad) = local_app_data.filter(|p| p.is_absolute()) {
        let installed = lad.join(if ctrl {
            REPORT_APP_INSTALLED
        } else {
            MAIN_APP_INSTALLED
        });
        if installed.is_file() {
            return installed;
        }
    }
    portable
}

/// PCT-199 AQ-5: `std::env::current_exe()` の結果から起動先解決の起点ディレクトリを求める。
/// `unwrap_or_default()` で空パスへ黙ってフォールバックすると、以降の `resolve_target` が
/// 相対パスを返してしまい `Command::new` が PATH 環境変数を探索する (binary planting の表層)。
/// ここでは成功時のみ `Ok(base_dir)` を返し、失敗時は `Err` を伝播させて呼び出し側で
/// 相対パス起動を試みずに終了させる。
fn resolve_base_dir(current_exe: std::io::Result<PathBuf>) -> std::io::Result<PathBuf> {
    current_exe.and_then(|p| {
        p.parent()
            .map(|p| p.to_path_buf())
            .ok_or_else(|| std::io::Error::other("no parent directory"))
    })
}

/// PCT-199 AQ-5: エラーを MessageBox で可視化する。ランチャーはコンソールを持たない
/// windows subsystem のため、標準エラー出力はユーザーに見えない。無反応に見える事故を防ぐ。
fn show_error(message: &str) {
    let title: Vec<u16> = "Peco Launcher".encode_utf16().chain(std::iter::once(0)).collect();
    let body: Vec<u16> = message.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        MessageBoxW(
            None,
            PCWSTR(body.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_OK | MB_ICONERROR,
        );
    }
}

fn main() {
    // PCT-199 AQ-5: current_exe() 取得失敗時に base_dir を空パスへフォールバックすると、
    // 後続の resolve_target が相対パス ("Peco.exe" 等) になり、Command::new が PATH 環境変数を
    // 探索してしまう (binary planting の表層)。失敗時はエラー表示して即座に終了し、
    // 相対パスでの起動を試みない。
    let base_dir = match resolve_base_dir(std::env::current_exe()) {
        Ok(dir) => dir,
        Err(e) => {
            show_error(&format!(
                "起動先の実行ファイルを特定できませんでした。\n\n詳細: {e}"
            ));
            return;
        }
    };

    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let target = resolve_target(&base_dir, local_app_data, ctrl_held());

    // ランチャーに渡された引数はそのまま転送する (将来の PDF パス受け渡しに使う)。
    let forwarded: Vec<String> = std::env::args().skip(1).collect();

    // PCT-199 AQ-5: spawn 失敗を `let _ =` で握りつぶすと exe 不在時に無反応になる。
    // MessageBox でエラーを可視化する。
    if let Err(e) = Command::new(&target).args(&forwarded).spawn() {
        show_error(&format!(
            "起動に失敗しました:\n{}\n\n詳細: {e}",
            target.display()
        ));
    }
    // ランチャー自身は常駐せず即終了する。
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_main_app_when_ctrl_not_held() {
        let base = PathBuf::from(r"C:\Program Files\Peco");
        let p = resolve_target(&base, None, false);
        assert!(p.ends_with("Peco.exe"));
    }

    #[test]
    fn resolves_report_tool_when_ctrl_held() {
        let base = PathBuf::from(r"C:\Program Files\Peco");
        let p = resolve_target(&base, None, true);
        assert!(p.ends_with("PecoReportTool.exe"));
    }

    #[test]
    fn target_is_anchored_to_base_dir() {
        let base = PathBuf::from(r"C:\Program Files\Peco");
        let p = resolve_target(&base, None, false);
        assert!(p.starts_with(r"C:\Program Files\Peco"));
    }

    /// テスト用の一時ディレクトリを作る（テスト名で分離・毎回クリーン）。
    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("peco-launcher-test").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &PathBuf) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"").unwrap();
    }

    // R5 実測レイアウト: 隣接に exe が無く LOCALAPPDATA 側に実在する場合、
    // Tauri NSIS 既定インストール先（%LOCALAPPDATA%\Peco\Peco.exe）へフォールバックする。
    #[test]
    fn falls_back_to_default_install_layout_when_not_adjacent() {
        let base = temp_dir("fallback-base"); // 隣接には何も置かない
        let lad = temp_dir("fallback-lad");
        touch(&lad.join("Peco").join("Peco.exe"));
        touch(&lad.join("PecoReportTool").join("PecoReportTool.exe"));

        let main = resolve_target(&base, Some(lad.clone()), false);
        assert_eq!(main, lad.join("Peco").join("Peco.exe"));

        let report = resolve_target(&base, Some(lad.clone()), true);
        assert_eq!(report, lad.join("PecoReportTool").join("PecoReportTool.exe"));
    }

    // 隣接（ポータブル配置）に exe が実在するなら LOCALAPPDATA より優先する。
    #[test]
    fn adjacent_portable_layout_takes_precedence() {
        let base = temp_dir("portable-base");
        touch(&base.join("Peco.exe"));
        let lad = temp_dir("portable-lad");
        touch(&lad.join("Peco").join("Peco.exe"));

        let p = resolve_target(&base, Some(lad), false);
        assert_eq!(p, base.join("Peco.exe"));
    }

    // どちらにも実在しない場合は隣接パスを返す（spawn 失敗の MessageBox で可視化される）。
    #[test]
    fn returns_adjacent_path_when_nothing_exists() {
        let base = temp_dir("missing-base");
        let lad = temp_dir("missing-lad");
        let p = resolve_target(&base, Some(lad), false);
        assert_eq!(p, base.join("Peco.exe"));
    }

    // PCT-199 AQ-5 同型回帰: LOCALAPPDATA が空文字（var_os は unset=None だが空値=Some("")）
    // でも相対パスを返さない。空文字を join すると相対パスになり、CWD 基準の is_file() を
    // すり抜けて相対パス起動が復活する穴をセキュリティレビューで指摘・封止した。
    #[test]
    fn empty_local_app_data_never_yields_relative_path() {
        let base = temp_dir("empty-lad-base"); // 隣接なし
        let p = resolve_target(&base, Some(PathBuf::from("")), false);
        assert!(p.is_absolute());
        assert_eq!(p, base.join("Peco.exe"));
    }

    // 同上: 相対パスの LOCALAPPDATA も拒否する。
    #[test]
    fn relative_local_app_data_is_rejected() {
        let base = temp_dir("rel-lad-base");
        let p = resolve_target(&base, Some(PathBuf::from(r"AppData\Local")), false);
        assert!(p.is_absolute());
        assert_eq!(p, base.join("Peco.exe"));
    }

    // PCT-199 AQ-5 回帰: current_exe() 成功時は親ディレクトリを返す。
    #[test]
    fn resolve_base_dir_returns_parent_on_success() {
        let exe = PathBuf::from(r"C:\Program Files\Peco\PecoLauncher.exe");
        let result = resolve_base_dir(Ok(exe));
        assert_eq!(result.unwrap(), PathBuf::from(r"C:\Program Files\Peco"));
    }

    // PCT-199 AQ-5 回帰: current_exe() が失敗した場合、空パス（相対パス起動に繋がる値）へ
    // 黙ってフォールバックせず Err を返すこと。これにより呼び出し側の resolve_target が
    // "Peco.exe" のような相対パスを組み立てて Command::new が PATH 探索に落ちる
    // (binary planting の表層) 事故を防ぐ。
    #[test]
    fn resolve_base_dir_propagates_error_instead_of_defaulting() {
        let err = std::io::Error::other("current_exe unavailable");
        let result = resolve_base_dir(Err(err));
        assert!(result.is_err());
    }

    // PCT-199 AQ-5 回帰: current_exe() がルート直下 (親ディレクトリなし) を返すような
    // 異常系でも Err になり、空パスへフォールバックしないこと。
    #[test]
    fn resolve_base_dir_errors_when_no_parent() {
        let exe = PathBuf::from(r"C:\");
        let result = resolve_base_dir(Ok(exe));
        assert!(result.is_err());
    }
}
