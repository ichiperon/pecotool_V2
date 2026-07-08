; PecoSuite 統合インストーラ — 骨格ドラフト（実機未検証・ビルド対象外）
;
; 計画書 §5.1: 本体 NSIS インストーラ + 帳票ツール NSIS インストーラ + PecoLauncher.exe
; を 1 本に束ね、ショートカットはランチャーのみ作成する。
; Tauri の bundle 機能（conf 操作 = 本体改変）は使わず、後段ラッパーで統合する（本体無改変）。
;
; ┌─ R5 確定事項（Tauri NSIS 生成 installer.nsi の実測・2026-07-08）──────┐
; │ ・両アプリとも installMode=currentUser（既定）→ 実インストール先:       │
; │     本体:   %LOCALAPPDATA%\Peco\Peco.exe                                │
; │     帳票:   %LOCALAPPDATA%\PecoReportTool\PecoReportTool.exe            │
; │   （帳票 exe 名は tauri.conf の mainBinaryName で統一済み。未指定だと    │
; │     crate 名由来の report-tool.exe になる — 2026-07-08 ビルドで実測）    │
; │ ・RequestExecutionLevel は currentUser → user（本 nsi も user でよい）   │
; │ ・ランチャーは2段解決に変更済み: 隣接（ポータブル）→ %LOCALAPPDATA%     │
; │   既定レイアウトへフォールバック。子インストーラを /D= で誘導しなくても │
; │   既定インストールのままで起動できる。                                  │
; └──────────────────────────────────────────────────────────────────────┘
; ┌─ 残・実機検証項目（インストーラ実行を伴うもの）───────────────────────┐
; │ 1. Tauri NSIS の /S サイレント実行と終了コード（計画書の /PASSIVE は     │
; │    msiexec 系の流儀で NSIS には無い → /S を使う前提で実機確認）。        │
; │ 2. /S 時に子インストーラがデスクトップ/スタートメニューのショートカット │
; │    を作るか（作るなら本 nsi で削除してランチャーのみに統一）。           │
; │ 3. Ctrl+ダブルクリックの検出精度（Explorer 実機）。                      │
; └──────────────────────────────────────────────────────────────────────┘
;
; ビルド（makensis 導入後）:
;   makensis /DMAIN_SETUP=..\dist-bin\Peco_x.y.z_x64-setup.exe ^
;            /DREPORT_SETUP=..\dist-bin\PecoReportTool_a.b.c_x64-setup.exe ^
;            /DLAUNCHER_EXE=..\crates\launcher\target\release\PecoLauncher.exe ^
;            /DSUITE_VERSION=x.y.z installer\bundle.nsi

!ifndef SUITE_VERSION
  !define SUITE_VERSION "0.0.0"
!endif

Name "Peco Suite ${SUITE_VERSION}"
OutFile "PecoSuite_${SUITE_VERSION}_x64-setup.exe"
Unicode true
RequestExecutionLevel user  ; R5確定: 子インストーラは両方 currentUser なので user でよい

; ランチャー配置先。子アプリは各自の既定先（%LOCALAPPDATA%\Peco / \PecoReportTool）に
; インストールされ、ランチャーが %LOCALAPPDATA% フォールバックで解決するため、
; ここは /D= で子を誘導しない独立ディレクトリでよい。
InstallDir "$LOCALAPPDATA\PecoSuite"

Page instfiles

Section "Install"
  SetOutPath "$INSTDIR"

  ; --- 1. 本体 PecoTool（サイレント）---------------------------------------
  ; 子は既定の %LOCALAPPDATA%\Peco へ入れる（/D= 誘導不要 — ランチャー側が解決）
  File "/oname=$PLUGINSDIR\main-setup.exe" "${MAIN_SETUP}"
  ExecWait '"$PLUGINSDIR\main-setup.exe" /S' $0
  IntCmp $0 0 +3 0 0
    MessageBox MB_ICONSTOP "本体のインストールに失敗しました (exit=$0)"
    Abort

  ; --- 2. 帳票ツール PecoReportTool（サイレント）----------------------------
  File "/oname=$PLUGINSDIR\report-setup.exe" "${REPORT_SETUP}"
  ExecWait '"$PLUGINSDIR\report-setup.exe" /S' $0
  IntCmp $0 0 +3 0 0
    MessageBox MB_ICONSTOP "帳票ツールのインストールに失敗しました (exit=$0)"
    Abort

  ; --- 3. ランチャー配置 -----------------------------------------------------
  File "/oname=PecoLauncher.exe" "${LAUNCHER_EXE}"

  ; --- 4. ショートカット（ランチャーのみ・計画書 §2）------------------------
  CreateShortcut "$DESKTOP\Peco.lnk" "$INSTDIR\PecoLauncher.exe"
  CreateShortcut "$SMPROGRAMS\Peco.lnk" "$INSTDIR\PecoLauncher.exe"
  ; TODO: 子インストーラが作る個別ショートカットの抑止方法を実機確認
  ;       （Tauri NSIS の /S でショートカットが作られる場合は削除する）

  ; --- 5. アンインストーラ登録 ----------------------------------------------
  ; TODO: 子アプリ2つ＋ランチャーを束ねる uninstall 設計（フェーズ後ろ・実機確認後）
SectionEnd
