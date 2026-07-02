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

// インストール先レイアウトは Tauri NSIS の実出力を実機確認してから確定する (計画書 R5 / 未確定事項)。
// 暫定の前提: ランチャーと同じディレクトリに本体 exe、サブフォルダに帳票ツール exe が配置される。
const MAIN_APP_REL: &str = "Peco.exe";
const REPORT_APP_REL: &str = "report-tool/PecoReportTool.exe";

/// 起動直後の Ctrl キー押下状態を返す。GetAsyncKeyState の最上位ビットが押下を表す。
fn ctrl_held() -> bool {
    unsafe { (GetAsyncKeyState(VK_CONTROL.0 as i32) as u16) & 0x8000 != 0 }
}

/// ランチャー exe の隣を起点に、起動対象 exe の絶対パスを組み立てる。
fn resolve_target(base_dir: &PathBuf, ctrl: bool) -> PathBuf {
    let rel = if ctrl { REPORT_APP_REL } else { MAIN_APP_REL };
    base_dir.join(rel)
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

    let target = resolve_target(&base_dir, ctrl_held());

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
        let p = resolve_target(&base, false);
        assert!(p.ends_with("Peco.exe"));
    }

    #[test]
    fn resolves_report_tool_when_ctrl_held() {
        let base = PathBuf::from(r"C:\Program Files\Peco");
        let p = resolve_target(&base, true);
        assert!(p.ends_with("PecoReportTool.exe"));
    }

    #[test]
    fn target_is_anchored_to_base_dir() {
        let base = PathBuf::from(r"C:\Program Files\Peco");
        let p = resolve_target(&base, false);
        assert!(p.starts_with(r"C:\Program Files\Peco"));
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
