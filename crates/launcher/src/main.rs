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

use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL};

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

fn main() {
    let base_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default();

    let target = resolve_target(&base_dir, ctrl_held());

    // ランチャーに渡された引数はそのまま転送する (将来の PDF パス受け渡しに使う)。
    let forwarded: Vec<String> = std::env::args().skip(1).collect();

    let _ = Command::new(&target).args(&forwarded).spawn();
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
}
