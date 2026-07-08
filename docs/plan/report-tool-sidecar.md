# 機能追加計画書：帳票ツール（サイドカー方式・外ヅラ統合）

- 起案日: 2026-06-25
- ステータス: フェーズ0完了 / フェーズ1コアロジック完了（テスト128件緑・#374〜376修正済）/ UI・OCR統合は #377 で追跡（§12）
- 旧計画 `docs/plan/template-ocr-csv.md`（本体組込前提）は本書で置換・廃止。機能ロジックは本書 §7 に移植して再利用。

## 1. 背景と方針

経理が定型帳票（毎ページ同じレイアウトの請求書・伝票）から特定欄だけを抜き出し、CSVで集計したい。要求は次の通り。

- 複数の欄を矩形で固定 → 全ページに同一座標でWindowsOCR
- 横持ちCSV出力（1ページ=1行、列=各欄、BOM付きUTF-8）
- 手書き等でOCR不能な欄は手動でBB追加 → 手動テキスト編集
- BBの座標からどの欄（項目）に属するかを自動判定＋手修正
- BBと項目の対応が一目で分かる可視化

### 設計の2本柱

1. **中身は別ツール**：帳票機能を本体に組み込まず、別プロセス・別コードベースの独立アプリにする。本体PecoToolの出荷ゲート（保存の正しさ・表示の正しさ）にリグレッションを一切持ち込まない。
2. **外ヅラは1ツール**：ユーザーから見えるのはアイコン1つ・インストーラ1つ。起動を「ランチャー」で出し分ける。通常ダブルクリック＝本体、Ctrl+ダブルクリック＝帳票ツール。

この2つは「ランチャーを外側にかぶせる」ことで両立する。ランチャーが起動を分岐するので、**本体exe・本体confには一切触らず、本体差分はゼロ**になる。

### なぜ本体組込でないか

本体に組み込むと、OCR結果が `textBlocks`（保存・PDF焼き込み対象）を汚染するリスク、新規temp書き込みが fs scope と衝突して PCT-118 型の保存全滅を再燃させるリスク、リボン/モード排他のミスで既存「範囲指定」OCR・保存・回転・サムネイルにリグレッションが及ぶリスクを、回帰テストで延々潰し続けることになる。別プロセス・別ストア・別保存系・別 fs scope という物理境界で隔離すれば、**本体に差分が出ないこと自体がリグレッションゼロの保証**になる。

### 命名（本書で統一）

| 項目 | 値 |
|---|---|
| 製品名（外ヅラ） | Peco（アイコン1つ・統合インストーラ PecoSuite） |
| 本体 | PecoTool（既存、`com.ichip.pecotool-v2`、`Peco.exe`） |
| 帳票ツール | PecoReportTool（`com.ichip.peco-report-tool`、`apps/report-tool/`） |
| ランチャー | PecoLauncher（`crates/launcher/`、薄いネイティブexe・新規） |
| 帳票ツール updater JSON | `latest-report-tool.json`（本体は既存 `latest.json`） |
| リリースタグ | 本体 `v2.x.x` / 帳票 `report-v0.x.x` / 統合 `bundle-v2.x.x` |

## 2. 全体像

```
[デスクトップ/スタートメニューのアイコン1つ＝PecoLauncher]
   通常ダブルクリック    → 本体PecoTool (Peco.exe)
   Ctrl+ダブルクリック   → 帳票ツール (PecoReportTool.exe)
   ※選択ダイアログは出さない（Ctrl分岐のみ・隠し機能で割り切り）
```

- ランチャーは起動直後に `GetAsyncKeyState(VK_CONTROL)` でCtrl押下を判定し、対応するexeを子プロセス起動して自身は即終了するだけのネイティブexe
- 中身は別プロセス・別コードベース（本体無改変は維持）
- 配布は **同梱1インストーラ（PecoSuite）**。NSISラッパーが本体・帳票ツール・ランチャーを1本に束ね、ショートカットはランチャーのみ作る
- OCR・PDF描画・型などの共通部は当面コピーで持ち、共有化はフェーズ3で段階適用

## 3. 機能スコープ（帳票ツール側に載せる）

| 機能 | 内容 | フェーズ |
|---|---|---|
| テンプレOCR | 複数矩形を欄として固定 → 全ページ同一座標でWindowsOCR | 1 |
| 横持ちCSV | 1ページ=1行、列=各欄、BOM付きUTF-8 | 1 |
| 手書きBB | OCR不能欄に手動でBB追加 → 手動テキスト編集 | 2 |
| 項目マッピング | BB座標から所属欄を自動判定（座標ベース）＋手修正 | 2 |
| 可視化 | BBを所属欄の色で塗り、欄名ラベルを表示。対応が一目で分かる | 2 |

## 4. アーキテクチャ

### 4.1 本体無改変の担保＝（c）コピー発進 → 段階共有化

OCRの中核（`do_windows_ocr` / `run_ocr` 他）は `src-tauri/src/lib.rs` に密結合で内蔵されている（1500行超の単一lib、OCR単体テストも同居）。共有crateへ物理抽出すると本体ビルドと既存テストに即波及し「無改変」が初日に破れる。

| 案 | 本体改変リスク | 重複 | 採否 |
|---|---|---|---|
| (a) 本体をライブラリ参照 | 中（Rust側で `pub` 公開・分割が要る＝改変） | 低 | 不採用 |
| (b) 共通部を物理抽出し両方が依存 | 高（lib.rs手術＝本体テスト・ビルド直撃） | ゼロ | 初手は不採用（フェーズ3で限定適用） |
| **(c) コピー発進→段階共有化** | **無→低** | 高（初期のみ） | **採用** |

段階共有化の順（フェーズ3）：`types.ts`（純型・最安全）→ 純関数TS（csvQuote・座標変換・decideCellValue）→ OCR crate（最高リスク・独立Goゲート必須）。

### 4.2 モノレポ構成（非対称レイアウトで発進）

本体ディレクトリを今動かすとパス・CI・E2E・release.ps1・updaterが全部追従改修になる。フェーズ0では本体をルート据え置き、帳票ツールとランチャーだけ新設する。

```
pecotool_v2/
├─ src/                      ← 本体フロント（移動しない・無改変）
├─ src-tauri/                ← 本体Rust（移動しない・無改変）
├─ apps/
│  └─ report-tool/           ← 帳票ツール（新規・Tauri+React）
│     ├─ src/                ← PDF描画・BB編集・テンプレ・CSV
│     ├─ vite.config.ts      ← port 1421 固定
│     └─ src-tauri/          ← OCRはlib.rsからコピー
├─ crates/
│  └─ launcher/              ← ランチャー（新規・素のRust/Win32 exe）
│     ├─ Cargo.toml          ← name=peco-launcher, bin=PecoLauncher
│     └─ src/main.rs         ← GetAsyncKeyState→Ctrl分岐→spawn
├─ installer/
│  └─ bundle.nsi             ← 統合インストーラ（NSISラッパー・新規）
├─ scripts/
│  ├─ release.ps1            ← 本体（無改変）
│  ├─ release-report-tool.ps1 ← 帳票ツール専用（新規）
│  └─ release-bundle.ps1     ← 統合インストーラ生成（新規）
├─ package.json             ← "workspaces": ["apps/*"] 追加
└─ .github/workflows/quality-gate.yml ← launcher-build / report-tool-quality ジョブ追加（既存無変更）
```

ワークスペース選定：

- **フロント＝npm workspaces**（`"workspaces": ["apps/*"]` 追加のみ。本体スクリプトはルートスコープのまま無変更）
- **ランチャー＝素のRust crate**（`crates/launcher/`）。Tauri不要・依存ほぼゼロ・exe数百KB。本体 `Cargo.toml`/`Cargo.lock` に触れず独立ビルド
- **帳票ツールRust＝cargo workspace統合はフェーズ3送り**。フェーズ0では独立ビルド（別lock）。ルート `Cargo.toml` でのworkspace統合は本体 `Cargo.lock` 解決に影響しうる（R4）ため、`cd src-tauri && cargo test` が壊れないと検証してから統合

> 設計裁定：cargo workspace統合タイミングでArchitect（フェーズ3送り）とDevOps（フェーズ0統合）が割れたが、「本体を壊さない」最優先で保守案を採用。

### 4.3 起動連携＝ランチャー方式（本体差分ゼロ）

URIスキーム案・本体内ボタン案は不採用。**ランチャーexeで完全に外側分岐**する。

```rust
// crates/launcher/src/main.rs（骨格）
#![windows_subsystem = "windows"]
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL};
fn main() {
    let base = std::env::current_exe().ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf())).unwrap_or_default();
    let ctrl = unsafe { (GetAsyncKeyState(VK_CONTROL.0 as i32) as u16) & 0x8000 != 0 };
    let target = base.join(if ctrl { r"PecoReportTool\PecoReportTool.exe" }
                           else     { r"Peco\Peco.exe" });
    let _ = std::process::Command::new(&target).spawn();
}
```

- 起動直後の `GetAsyncKeyState(VK_CONTROL)` でCtrlを読む（Officeのセーフモード起動と同じ定番手法）
- 本体フロントに起動ボタンは不要。**本体の差分はゼロ**（exe・conf・起動パスに一切触れない）
- 現在開いているPDFパスの受け渡しは今回スコープ外（帳票ツールは起動後に自前でPDFを開く）。必要なら引数受け渡しを後で追加
- 実exeへの相対パス（`Peco\Peco.exe` の階層）はTauri NSISの実際のインストール先を実機確認してから確定（R5）

### 4.4 データ受け渡し・読み取り専用

- 帳票ツールは `pdfPath` を受けて自前で読み込み（本体メモリ状態は共有しない＝疎結合）
- 帳票ツールは入力PDFを書き換えない（読み取り専用）。OCRはbytes直渡しでtemp経由しない → **PCT-118の罠にそもそも触れない**
- 出力CSVはユーザーが保存ダイアログで選んだパスにBOM付きUTF-8で書き出す
- handoffファイルを使う場合も `report-*` プレフィックスで本体temp（`.pecotool-*.tmp`）と名前空間を分離

## 5. ビルド・配布・CI

### 5.1 同梱1インストーラ（PecoSuite）

Tauriのbundle機能（conf操作＝本体改変）ではなく、**後段のNSISラッパーで統合**する（本体無改変）。

`installer/bundle.nsi` が、本体NSISインストーラと帳票ツールNSISインストーラをそれぞれ `/PASSIVE`（ダイアログなし）で実行し、ランチャーexeを配置、ショートカットはランチャーのみ作成する。

```
[本体インストーラ] ─┐
[帳票インストーラ] ─┼→ bundle.nsi が束ねる → PecoSuite_2.x.x_x64-setup.exe
[PecoLauncher.exe]─┘   （アイコン＝ランチャーのみ）
```

実機確認が要る点：Tauri NSISのインストール先パス、`/PASSIVE` 対応、`makensis` のCI導入（`choco install nsis`）。

### 5.2 署名鍵

- exe署名（コード署名証明書）：**共用可**（同一発行元）
- updater署名（minisign）：**アプリ別に分離**（同一鍵だと本体updaterが帳票ツールの.sigを誤検証）。`npx tauri signer generate -w "$HOME\.tauri\peco_report_tool.key"` で帳票ツール用を別生成

### 5.3 自動更新＝各アプリ個別updater（方式A）

| コンポーネント | 更新方法 | updater JSON | 本体への影響 |
|---|---|---|---|
| 本体PecoTool | Tauri updater（既存） | `latest.json`（既存） | **無改変** |
| 帳票ツール | Tauri updater（新規） | `latest-report-tool.json` | なし（帳票側のみ） |
| ランチャー | 統合インストーラ再配布で更新 | なし | なし |

ランチャーはロジックが薄く更新頻度ほぼゼロ。変更時は統合インストーラ新版を配ればランチャーも置き換わる。本体の既存 `latest.json` 自動更新は一切壊さない。

### 5.4 CI

`.github/workflows/quality-gate.yml` に2ジョブ追加（既存 `quality`・`pdf-soak` は無変更、`needs:` で依存させず並列）：

- `launcher-build`：`crates/launcher` を `cargo build --release` し、`PecoLauncher.exe` 生成を確認
- `report-tool-quality`：帳票ツールの build＋unit test＋debug Tauri build

### 5.5 リリースフローとバージョニング

本体 `release.ps1` は無改変。新規 `scripts/release-bundle.ps1` が「本体ビルド→帳票ビルド→ランチャービルド→成果物集約→NSIS統合→`pecotool-releases` へ `bundle-v*` で公開」を担う。

統合インストーラのバージョンは**本体バージョンに合わせる**（ユーザーには「Pecoのバージョン」しか見えないため）。帳票ツールは内部で独立バージョンを保持。

### 5.6 開発体験

本体は `npm run tauri dev`（port 1420）、帳票ツールは `apps/report-tool` で `npm run tauri dev`（port 1421・strictPort）。ランチャーは `cargo run`。ポート競合なし。本体scriptは無変更。

## 6. フェーズ分けと成果物

| フェーズ | スコープ | 本体への差分 |
|---|---|---|
| **0: 基盤** | モノレポ土台（workspaces追記・帳票Rust独立ビルド）、帳票ツール空アプリ（PDF表示まで）、ランチャー（Ctrl分岐）、CIジョブ追加 | **ゼロ** |
| **1: テンプレOCR＋CSV** | 複数矩形固定→全ページ同一座標OCR→横持ちCSV（BOM付きUTF-8）、進捗/キャンセル、統合インストーラ実体化 | なし |
| **2: 手書きBB＋マッピング＋可視化** | 手動BB追加・手動テキスト編集、座標ベース項目自動判定＋手修正、色分け/ラベル可視化 | なし |
| **3: 共有化最適化（任意）** | leaf順で共有化（types→純関数→OCR crate）、本体 `apps/pecotool/` 移設、workspace完全統合 | あり（独立Goゲート・RC基準テスト全緑必須） |

### フェーズ0の最小セット（DevOps整理）

| 作業 | フェーズ0要否 |
|---|---|
| `crates/launcher/`（Cargo.toml・main.rs） | 必須 |
| `launcher-build` CIジョブ | 必須 |
| 帳票ツールスケルトン＋`report-tool-quality` ジョブ | 必須 |
| `package.json` workspaces追記 | 必須 |
| `installer/bundle.nsi` 骨格 | 後回し可（本体・帳票が揃ってから） |
| `scripts/release-bundle.ps1` 骨格 | 後回し可 |
| 帳票ツール updater鍵生成 | 帳票初回リリース前でよい |
| 統合インストーラ実機テスト | フェーズ後ろ |

フェーズ0は別々に起動できれば十分。同梱インストーラ統合はフェーズ1以降でよい。本体diffはゼロ。

## 7. 機能設計詳細（帳票ツール内に新規実装）

旧計画から移植。本体ではなく `apps/report-tool/` 内に実装。

### 7.1 データモデル

```ts
// ページ座標 (scale=1.0 viewport, y-down)。ズーム・回転非依存。
interface OcrTemplateRegion {
  id: string;
  name: string;        // 列名（欄名）。空なら CSV 時 "範囲N"
  rect: BoundingBox;   // { x, y, width, height }
  color: string;       // 可視化用の割当色（フェーズ2）
}
interface OcrTemplate {
  regions: OcrTemplateRegion[];
  basePageIndex?: number; // 将来のページ別微調整に備えた余地
}
```

### 7.2 全ページOCRフロー

本体 `processAllPages` の制御構造（epoch停止・順序変更検知・キャンセル・EMA進捗・`setTimeout(0)`・25ページごとcleanup）をコピー流用し、内側だけ差し替え。

```
for ページ p in targets:
    ページ全体を1回だけオフスクリーンrender   ← 範囲数だけrenderし直さない
    for 範囲 r in template.regions:
        r を回転考慮でクロップ → run_ocr → OcrResultBlock[]
        cells[p][r.id] = decideCellValue(blocks)
結果 = Map<pageIndex, Map<regionId, string>>
```

`decideCellValue(blocks)`：空ブロック除外 → 読み順ソート → 直結連結（欄は1トークン前提。複数行欄の改行保持は要確認）→ 0件なら空文字。回転は `rect` を非回転ページ座標で持ち、クロップ時に `getViewport({ scale, rotation })` で変換。rotation混在PDFはMVP対象外（警告）。

### 7.3 横持ちCSV

ヘッダ：`page` + 各 `region.name`（空なら `範囲{n}`）。データ行：ページ番号（1始まり・表示順）＋ 各範囲セル値（`regions` 定義順で固定列）。全フィールド `csvQuote`（RFC4180）、改行 `\r\n`。BOMはファイル書き出し時にバイト付与（`0xEF 0xBB 0xBF`）。

### 7.4 手書きBB（フェーズ2）

OCR不能欄に矩形ドラッグで手動BB作成＋テキスト直接入力。手動BBもOCR由来と同じ `TextBlock` 構造で扱い、マッピング・CSVに同じ経路で乗る。OCR結果が空/低信頼度のセルをハイライトして手動入力へ誘導する導線を検討（要確認）。

### 7.5 項目マッピング（座標ベースを軸・フェーズ2）

「範囲＝列＝項目」なのでBBの項目は座標で決まる。

- `assignRegionByCoord(bb, template)`：BB中心座標がどの `region.rect` に入るかで所属決定。複数範囲に重なれば面積最大。どこにも入らなければ「未割当」
- 手動追加BBも同じ判定に乗る
- 誤判定はユーザーが手修正（所属欄を付け替え）
- 内容ベース推定（金額/日付らしさを正規表現で当てる）はフェーズ後ろの拡張候補。MVPは座標ベースで十分（要確認）

### 7.6 可視化（フェーズ2）

各範囲に色を割り当て（`region.color`）、canvas上でBBをその色で塗り欄名ラベルを添える。範囲一覧パネルで欄名・色・割当BB数を一覧。CSVはこのマッピング結果で整理される。

### 7.7 OCR結果の確認・編集UI（ページ横並びエディタ）

本体PecoToolは「BBごとに縦にOCRテキストエリアが並ぶ」エディタ（OcrEditor）。帳票ツールでは**横持ちCSVに合わせ、ページごとに値を横並び**で表示・編集する。プレビュー＝編集＝出力を一体化する。

- 右ペインに全ページのOCR結果を表示。**1ページ=1行**、その行に各欄の値が**横に並ぶ**（横持ちCSVの1行と一致）。全ページ分を縦に積み、スクロールで確認・調整できる。
- セル単位の操作:
  - **Delete**: OCR誤判定セルの削除（値を空に／該当BBを除外）
  - **ダブルクリック**: インラインで中身を修正（OCR誤読の手直し）
  - **ドラッグ&ドロップ**: 並び替えは**ページ内のみに厳格制限**（横方向）。**ページをまたぐ移動は禁止**——行＝ページの対応が壊れCSVが破綻するため（ユーザー指摘）。OCRが欄の対応を取り違えた値を正しい列へ移す**補正**操作
- この**編集結果がそのまま「CSV保存」でCSVになる**。段階1の `CsvPreviewTable`（横持ち表）を、編集可能なエディタへ発展させる。

**設計上の論点（実装時に designer と詰める）**:
- **セル横幅は要相談**（ユーザー指摘）。欄数・値の長さに応じて固定幅／可変／横スクロールのいずれか。
- **ドラッグ並び替えと列順固定の整合**: 横持ちCSVは会計ソフト取込のため列順を固定する（§7.3）。よってドラッグは「列見出しの順序を変える」のではなく「**誤った列に入った値を正しい列へ移す（値の再割り当て）**」操作とする。列の定義順はテンプレ順を維持。
- **項目マッピング手修正（§7.5）との統合**: `assignRegionByCoord` の誤判定をドラッグで直すのと、このセル並び替えは同じ「値→欄の対応を直す」操作。UIとして統合する。
- **自動整列が理想（ユーザー指摘）**: 手動ドラッグは補助に留め、理想は OCR結果を座標ベース（§7.5 `assignRegionByCoord`）で**自動的に正しい欄へ整列**させること。ユーザーは自動整列が外した箇所だけをドラッグ／編集で直す。自動整列の精度を上げ、手動操作を最小化するのを目標とする。ページ跨ぎ移動は仕組みとして発生させない（ページ内に閉じる）。

**フェーズ位置づけ**: フェーズ2（手書きBB・マッピング・可視化）と一体。#377 の段階としては OCR実機（段階4）の後に **段階5: OCR結果編集UI（横並び・Delete・ダブルクリック修正・ドラッグ補正）** を置く。本体ぺこの縦UIに対する「横並び＝帳票CSV向け」の差別化点。

## 8. 不変条件

- A：フェーズ0〜2で本体（`src/**`・`src-tauri/**`・`tauri.conf.json`・`scripts/release.ps1`）の差分は**ゼロ**。ランチャーが外側分岐するため起動ボタンすら不要
- B：受け渡しで本体temp（`.pecotool-*.tmp`）に書き込まない・干渉しない。handoffは `report-*` で名前空間分離
- C：帳票ツールは入力PDFを書き換えない（読み取り専用）。OCRはbytes直渡しでtemp経由しない（PCT-118回避）
- D：帳票ツールのbundle identifierは本体と別（`com.ichip.peco-report-tool`）。updater署名鍵も別
- E：共有化（フェーズ3）はleaf順。OCR crate切り出しは独立Goゲート（RC基準テスト全緑）を通すまで本体へ反映しない
- F：本体の既存自動更新（`latest.json`）を壊さない。帳票ツール・ランチャーの更新は本体updaterと独立

## 9. 主要リスク

| # | リスク | 対策 |
|---|---|---|
| R1 | 共有crate化（フェーズ3）の本体ビルド波及 | フェーズ3まで遅延。独立タスク＋RC基準（広域 `npm test`＋cargo）全緑で確認 |
| R2 | 2アプリの型ずれ（types.ts二重メンテ） | typesを最初の共有化対象に。改変時は両方更新をPRチェックリスト化 |
| R3 | 統合インストーラの複雑性（NSISラッパーで2インストーラ＋ランチャー同梱） | `/PASSIVE` 実行・終了コードチェック。実機テストはフェーズ後ろ |
| R4 | cargo workspace統合で本体lock解決変化 | フェーズ0は帳票ツール独立ビルド。統合は検証後 |
| R5 | ランチャーから実exeへの相対パス／Ctrl検出精度 | Tauri NSISの実インストール先を実機確認して定数確定。Ctrl+ダブルクリックの検出精度も実機確認 |
| R6 | WindowsOCRスレッド安全性（並列クロップOCR） | MVPは直列。実機手動確認必須 |

## 10. 未確定事項（着手前に確定）

### 確定済み（2026-07-08・Tauri NSIS 生成 installer.nsi の実測）

- **Tauri NSISの実インストール先パス** → 両アプリとも `installMode=currentUser`（既定）で
  本体 `%LOCALAPPDATA%\Peco\Peco.exe` / 帳票 `%LOCALAPPDATA%\PecoReportTool\PecoReportTool.exe`。
  帳票の exe 名は `mainBinaryName: "PecoReportTool"` を tauri.conf.json に追加して統一
  （未指定だと crate 名由来の `report-tool.exe` になることをビルドで実測）。
  ランチャーは2段解決（隣接ポータブル→ `%LOCALAPPDATA%` 既定レイアウト）に変更済み。
- **NSIS `/PASSIVE`** → NSIS に該当フラグは無い（msiexec 系の流儀）。サイレントは `/S` を使う
  （実機での終了コード・ショートカット生成有無の確認は残・`installer/bundle.nsi` に記載）。
- 複数行欄の改行保持 → **対応済み**（明細欄=textarea・y座標段分割・複数段CSV展開 / 2fcc321）

### 未確定（実機・運用判断待ち）

- `/S` サイレント実行の終了コードとショートカット生成有無（統合インストーラ実機テスト時）
- `makensis` のCI導入（`choco install nsis`）
- Ctrl+ダブルクリックの検出精度（Explorer上でのタイミング差）
- 帳票ツールの配布を `pecotool-releases` に `bundle-v*`/`report-v*` 同居でよいか
- updater 鍵の生成・保管（OPS-1・ユーザー判断。`scripts/release-report-tool.ps1` の前提1）
- 起動時にPDFパス／ページ範囲を渡す実需があるか（引数転送は実装済み・受け側が未配線）
- 項目マッピングは座標ベースで足りるか、内容ベース推定も要るか
- rotation混在PDFの扱い（MVPは対象外＝警告で足りるか）

## 11. 次アクション

1. 本計画書のレビュー・合意
2. フェーズ0を着手（モノレポ土台＋帳票ツールスケルトン＋ランチャーCtrl分岐＋CIジョブ）。本体diffがゼロであることをPRで確認
3. 未確定のうち「Tauri NSISインストール先パス」「`/PASSIVE` 対応」はフェーズ0でランチャー定数を確定する前に実機検証
4. フェーズ1以降を `/feature` フローで順次実装（帳票ツール内のため本体テストと独立）

## 12. 実装状況（2026-06-25 時点）

### 完了
- **フェーズ0**: ランチャー `crates/launcher`（Ctrl分岐・build成功・test 3/3）、帳票ツール Tauri スケルトン `apps/report-tool`（build/test/cargo check 緑）。本体無改変を確認。
- **フェーズ1コアロジック**: `types/`・`store/`・`logic/`（横持ちCSV生成・座標マッピング・セル値決定・数値正規化）。unit test **128件全緑**。
- **品質**: レビュー4観点（総合/可読性/セキュリティ/性能）実施。不具合3件を修正フロー（issue→レビュー→修正→再レビュー→クローズ）で完遂。
  - #374 CSV Formula Injection（半角＋全角`＝＋－＠`＋LF＋先頭空白/NBSP/ゼロ幅を `'` 中和、正当な負数は非中和）→ クローズ
  - #375 reportStore の fieldCounter 状態漏れ＋可読性（`crypto.randomUUID()` 化）→ クローズ
  - #376 normalizeNumeric データ品質（全角％・全角カンマ・△負数化ガード・数値判定厳格化）→ クローズ

### 未着手（#377 で追跡）
PDF描画移植・欄定義UI・全ページOCR実機・UI配線・CSVプレビュー・CSV保存・ランチャー連携。**コアロジックはUIに未配線でアプリとしてはまだ動かない**。

### UI/UX設計（designer 天音かなた / user_advocate 戌神ころね 検討済み・実装はフェーズ1 UI／フェーズ2）
- 画面: 「①定義→②適用→③確認→④出力」ステップバー、3ペイン（サムネ／PDF／欄テンプレ＋CSVプレビュー）
- 可視化: 欄＝色＋ラベル＋枠線の3冗長、未割当BB＝警告点線、空セル/低信頼ハイライト、「次の未入力へ▶」連続つぶし
- 経理実務要件: 元ファイル名/ページ番号列、空セル扱い設定、数値正規化、手修正フラグ、文字コード切替（Shift_JIS=将来issue）、異常値検出、**テンプレ保存/呼び出し（時短の核・MVP級）**
- データ信頼性: OCR誤読（金額化け）対策として出力前プレビュー確認・低信頼セル可視化・合計欄突合（将来）
