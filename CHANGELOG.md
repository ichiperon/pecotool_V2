# Changelog

このプロジェクトは [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠し、
[Semantic Versioning](https://semver.org/lang/ja/) を採用しています。

---

## [2.0.21] - 2026-06-15

### Added

- **OCR位置補正を全ページに適用する手段を追加** (50a870a): プレビューは常に全ページを適用して一時 PDF を生成する。「全ページに適用して保存」ボタンを別途用意し、保存時の全ページ再描画を意図的に実行できる。通常の Ctrl+S 上書き保存は dirty ページのみのまま据え置き（全ページ再描画は重く、dirty-only 最適化の保存テストを壊すため自動化しない）。PecoToolメタを持たない素の OCR ページは再描画で抽出近似により僅かに座標が動く可能性があり、保存前にプレビューで確認する運用を想定。

### Fixed

- **プレビューが fs スコープ違反で失敗する不具合を修正** (#285 回避, d0586f3): Windows の `\\?\` prefix 正規化（#285）により `$TEMP` が Tauri file scope の glob にマッチしなくなっていたのが原因（"path is outside allowed Tauri file scope"）。Rust コマンド `open_pdf_preview` を新設し `temp_dir` 直書き＋opener 起動で回避。

---

## [2.0.20] - 2026-06-15

### Added

- **OCR位置補正に「この補正値でプレビュー」ボタンを追加** (d97dc40): 現在の補正値で一時 PDF を毎回一意名（`peco_ocr_preview_<ts>.pdf`、`$TEMP` 以下）で書き出し、既定の PDF ビューアで開く。一意名のためビューアのキャッシュに当たらず、数値変更→プレビューの反復で位置を追い込める。プレビューは開いているドキュメントの状態（dirty/表示）を変更しない。

---

## [2.0.19] - 2026-06-15

### Added

- **保存 PDF の透明テキスト層の位置補正機能を追加** (daa5dad): Acrobat の Ctrl+A 選択範囲に相当する透明テキスト層を、表示座標系で平行移動する。既定は下 2mm・右 4mm、OCR 序列設定で調整可能（負値で上・左）。横書き/縦書き/曲線テキストの全描画経路に適用。アプリ内の画像表示・BB 枠には影響せず、保存 PDF の透明テキスト層のみに反映。回転 90/180/270 でも表示上の下/右へ一様に適用。

### Fixed

- **本番ビルドで plugin-updater が E2E スタブに解決される不具合を修正** (#328/PCT-105, e9be892): `vite.config.ts` の `resolve.alias` が `command === 'serve'` か否かを問わず常にスタブ（`check = async () => null`）へ向けていたのが原因（`resolve` は `tauri build` にも適用される）。alias を `command === 'serve'` 限定にし、本番ビルドでは `node_modules` の実プラグインをバンドルするよう修正。v2.0.15〜2.0.18 の配布版はすべてスタブ入りでビルドされており自動更新が機能しないため、回復には本修正後のビルドを一度手動インストールする必要がある。

---

## [2.0.18] - 2026-06-11

> **アーキテクチャ強化リリース** — 「貧弱性解析→最強システム」ロードマップ 9 issue（PCT-096〜104）の成果一式。
> 全改修はゴールデンマスター回帰スイート（保存往復の意味的不変性24テスト）と
> pdfSaver/worker 等価性テストの保護下で実施し、検収レビュー（計6往復・全指摘が実証付き）を経た。

### Fixed

- **ページ回転が本番保存で落ちる問題を修正** (PCT-096): pdfSaver.ts にはあるユーザー指定回転の適用（setRotation）が本番 Worker 保存経路に欠落しており、アプリ内で回転→上書き保存すると /Rotate が保存されなかった。PCT-052/053 と同型の二重実装漏れ3度目

### Changed

- **保存ロジックの単一実装化** (PCT-100): 二重実装（main 約540行 / Worker 約420行）を pdfSaverCore::buildPdfDocumentCore に統合（正味約-430行）。片経路だけの実装漏れが構造的に発生不能に。Worker 経路は main 版の挙動（孤児オブジェクト時の short-circuit 回避等）に統一
- **IDB 一時退避のキーを安定IDに変更** (PCT-104): ページ操作のたびに必要だった IDB キーの物理移動（rename 同期）を全廃し、「移動・undo・保存の交差で別ページの内容が混入する」系統のバグ（PCT-068/069/070 で12件消火した震源）を構造的に根絶。旧バージョンの未保存退避データは読み出しフォールバックで自動移行

### Performance

- OCR 画像の IPC 転送を raw body 化（PCT-101）: 2MB PNG が約16MB のヒープを消費していた number[] 変換を排除
- ページ並べ替えの IDB キー処理を O(N²)→O(N) 化（PCT-102）: 1000ページで5.2倍実測
- 保存メタの読み込みをメモ化（PCT-103）: 100MB級でページ表示のたびに走っていたファイル全読みを初回のみに。上書き保存時はキャッシュを明示破棄し古いメタを返さない

### Internal

- ゴールデンマスター回帰スイート新設（PCT-098）: 合成PDFコーパス7類型×保存往復の意味的不変性を critical ゲートで常時実行
- pdfSaver/worker 出力等価性テスト新設（PCT-097）: 二重実装漏れの機械的見張り（単一化後はアダプタの回帰ガードとして維持）
- 不変条件目録 docs/invariants.md 新設（PCT-099）: 97パッチの不変条件44条+棄却済み案6件を単一の照合先に

---

## [2.0.17] - 2026-06-10

### Fixed

#### 自動アップデートが機能しない（PCT-093）
- v2.0.15/2.0.16 で自動アップデートのチェックが常に失敗していた問題を修正。原因は capabilities/default.json に updater プラグインの permission（`updater:default`）が未登録だったこと。フロントエンドからの `check()` 呼び出しが即座に権限エラーとなり、エラーが UI に一切表示されない設計だったため「アップデート確認を押しても何も起きない」として隠蔽されていた
- 「アップデート確認」に結果フィードバックを追加: 確認中... / お使いのバージョンは最新です / 更新の確認に失敗しました（エラーは console にも記録）
- capability 整合テストに updater permission ガードを追加（plugin-updater 使用時に permission 欠如で fail）

> ⚠️ v2.0.15 / v2.0.16 がインストール済みの端末は本バグにより自動更新を受信できないため、v2.0.17 は手動インストールが必要（v2.0.17 以降は自動更新が機能する）。

---

## [2.0.16] - 2026-06-10

### Fixed

#### Acrobat 上のテキスト選択位置（PCT-092）
- 保存した PDF を Acrobat で開きテキストを選択（Ctrl+A 等）すると、選択ハイライトが文字より「左上に寄って」見える問題を改善。原因はベースライン位置を決める descent 比に Meiryo の行間設計込みメトリクス（≈0.293）をそのまま使っていたことで、スキャン和文活字の実ベースライン位置（行下端から約 10〜12%・IPAmjMincho 実測 0.1201）との乖離分だけテキスト論理位置が上（縦書きでは左）にずれていた。descent 比を明朝系実測に合わせ 0.12 で打ち切るキャップを導入（メイン/Worker の横書き・縦書き全描画経路に適用。検索・コピペ・抽出の互換性は不変）

---

## [2.0.15] - 2026-06-10

### Fixed

#### 保存の整合性（PCT-050, PCT-051）
- 保存完了処理の `clearTemporaryChanges` が `savePDF` 実行中に発生した新規 LRU 退避の IDB 書込を待たずにエントリを消去する競合を修正（`waitIdbSavesBeforeClear` を `clearIdbDirty` 直前に追加）(PCT-050)
- IME 変換中の Ctrl+S で `flushActiveOcrCardText` が未確定文字を含む `textContent` をストアにコミットしうる問題を修正（`compositionstart`/`compositionend` で `data-composing` 属性を設定し、flush 側でスキップ）(PCT-051)

#### OCR 信頼度・回転の保存往復（PCT-052, PCT-053）
- `pdf.worker.ts` の bboxMeta 書込で `confidence` フィールドが欠落し、Worker 経路で保存した場合に「要確認マーク」が復元されない問題を修正（`pdfSaver.ts` との実装齟齬を解消）(PCT-052)
- `pdf.worker.ts` の `page.getRotation().angle` に optional chaining がなく、エッジケースで例外が発生し当該ページの OCR 描画がスキップされる可能性を修正（`page.getRotation?.().angle ?? 0` に統一）(PCT-053)

#### サムネイル生成（PCT-054）
- サムネイル Worker 起動の `requestIdleCallback` timeout を 1500ms → 3000ms に延長（重量 PDF の初回レンダリングと起動タイミングが重なり帯域競合しうる問題を緩和。idle 時の挙動は従来どおり即起動）(PCT-054)

#### バックアップ・ウィンドウ閉じ（PCT-055）
- 自動バックアップ完了がユーザーに見えない問題を修正：完了時に「自動保存しました（HH:MM）」トーストを表示 (PCT-055)
- バックアップ書込中にウィンドウを閉じられるとデータが破損しうる問題を修正：`isBackingUpRef` を `useTauriCloseGuard` に連動して書込中の閉じ操作を抑止 (PCT-055)

#### バッチ処理（PCT-056）
- バッチ実行中にダイアログ外クリックで進捗ダイアログが閉じ、進捗が確認できなくなる問題を修正（`!isRunning` ガード追加）(PCT-056)

#### UI 文言・ダイアログ（PCT-057, PCT-058）
- バックアップ復元ダイアログのタイトル「未保存の内容があります」が通常の保存し忘れ警告と誤読される問題を修正（「前回の作業バックアップが見つかりました」へ変更）(PCT-057)
- OCR 未実行ページの空状態「OCRテキストなし」に次アクションの導線がない問題を修正（「このページに OCR テキストがありません」＋「リボンの「OCR 実行」でテキストを読み取れます」の 2 行構成へ変更）(PCT-058)

#### エラーメッセージ（R04D-2, R04D-3）
- 書込失敗トーストに OS エラー文字列（"os error 32" 等）が業務ユーザー向けにそのまま表示される問題を修正（「他のアプリでこの PDF が開かれている可能性があります。閉じてから再度保存してください。」へ変更。元の文字列は `console.warn` で保全）(R04D-2)
- 読込失敗トースト「元 PDF の読み込みに失敗しました。」に次アクション案内がない問題を修正（「元の PDF ファイルが移動または削除された可能性があります。ファイルを再度開き直してください。」へ変更）(R04D-3)

#### 保存データ整合性 — Deep-Fix（PCT-068〜070, PCT-074〜076）
- LRU 退避ページを再訪・編集して保存すると、IDB の古い一時データが新しい編集を上書きし**編集前の内容が PDF に書かれる**問題を修正（保存マージをメモリ優先に反転）(PCT-068)
- ページ移動/削除を Undo した後の保存で、IDB 一時データのキーが旧位置のままになり**別ページのテキストが混入**しうる問題を修正（Undo/Redo が IDB キーの rename を巻き戻すように）(PCT-069)
- 保存完了後の一時データ削除を「保存で実際に回収したページのみ」に限定（保存に載らなかった編集の理論的消失窓を閉鎖）(PCT-070)
- ファイル読込中に Ctrl+S（保存）が交差すると旧ファイルが不完全な内容で上書きされうる問題を修正（読込完了後の保存状態再チェック + 読込中の保存ガード）(PCT-074)
- 保存前 diff プレビュー表示中の保存ショートカット連打で保存処理が二重に走りうる問題を修正 (PCT-075)
- フォルダ一括処理中に「OCRテキストがありません」確認ダイアログが割り込み、バッチ OCR と並行書込が起きうる問題を修正 (PCT-076)

#### 保存の耐クラッシュ性 — Rust（PCT-077, PCT-078）
- 上書き保存の置換処理を単一アトミック rename に変更。従来の2段階 rename（退避→昇格）では、その間にプロセス強制終了・電源断が起きると保存先ファイル名が一時消失する窓があった。「Windows では rename が既存ファイルを上書きできない」という旧実装の前提が誤りであることを検証テストで実測確認した上で変更（`std::fs::rename` は `MoveFileExW(REPLACE_EXISTING)` を使用）。バックアップ一時ファイルの残留も同時に解消 (PCT-077)
- 置換 rename の直前にファイル内容をディスクへ sync するように（rename 直後の電源断で不完全な内容が確定するリスクを低減）(PCT-078)
- OCR の描画スケール引数に防御ガードを追加（0/NaN による座標破損の理論経路を閉鎖）(PCT-079)

#### リソース管理（PCT-071〜073）
- 大型 PDF のロード中に別ファイルを開いた際、進行中のロードを即時中断できるように（pdfjs loadingTask の保持と破棄）。連続切替時のメモリ滞留とハング時の恒久リークを解消 (PCT-072)
- ファイルを閉じた後もサムネイル Worker（最大4インスタンス）が PDF の解析データを保持し続ける問題を修正（CLOSE_PDF 通知で即時解放）(PCT-073)
- IDB 一時保存のタイムアウトタイマーが完了後も残留する問題を修正 (PCT-071)

### Performance

- 保存時、未編集ページの検査（Acrobat 7 互換損傷検知 + 空 q-Q 除去）で content stream が 2 回 decode されていたのを 1 回に削減。1000 ページ規模の保存で inflate 回数が約半減。旧経路との出力バイト列完全一致を differential テスト 6 本で保証し、損傷検知の検出能力は不変 (PCT-059)

### Changed

#### 自動更新（updater）
- 自動更新機能（`tauri-plugin-updater`）を `UPDATER_ENABLED = false` フラグで無効化して出荷（署名公開鍵 pubkey 未設定のため）。起動時の更新チェックと「アップデート確認」ボタンを無効化済み。pubkey 設定後の将来バージョンで有効化予定。なお 2.0.14 RC の「リリース前提条件: pubkey 必須」はこの方針変更により解消

#### UI・視覚フィードバック（R04D-1）
- 編集中（フォーカス中・未コミット）の OCR カードに amber 枠＋影を追加し、確定済みカードと視覚的に区別できるように変更（`.ocr-card:focus-within` スタイル。選択中の青枠が詳細度で優先される序列をコメントで明示）(R04D-1)

### Build

- `build.bat` のマニュアル同梱処理の不備を修正
- `package-lock.json` と `package.json` の不整合を修復（`@tauri-apps/plugin-updater` が lock 未登録・バージョン不一致により CI の `npm ci` が失敗する問題）

---

## [2.0.14] - 2026-06-04

> **Release Candidate (RC)**
>
> v1.6.3 以来 336 コミットを経た 2.x 系初の正式リリース候補。
> Tauri v2 へのフルマイグレーション、UI リアーキテクチャ、OCR エンジン刷新、
> および 2026-06-03〜04 の集中安定化セッション（PCT-001〜040）を経て RC に到達。
>
> **リリース前提条件**: `tauri-plugin-updater` の署名公開鍵（pubkey）が未設定。
> 本番リリースには `tauri.conf.json` の updater pubkey 設定が必須。

### Added

#### UI
- Excel 風リボン UI を導入し、従来の MenuBar を廃止 (#272〜#277)
  - タブ・グループ・ラージ/スモールボタンの 4 フェーズ段階実装
  - ResizeObserver によるレスポンシブ折り畳み
  - Alt キーアクセラレータ対応

#### OCR
- OCR 言語選択・多言語対応 (#190)
- 信頼度の可視化と低信頼テキストのハイライト表示 (#192)
- ページ範囲指定 OCR (#199)
- 選択矩形内の部分再 OCR (#191)
- OCR 処理中の残り時間・平均処理速度 (ms/ページ) 表示 (#200)
- 既存テキストレイヤーを検出して OCR をスキップし、テキストを取り込む機能 (#204)
- `run_ocr` をバイトベースの Tauri invoke に変更し、fs-scope 依存を排除 (#285)

#### ページ操作
- ページの削除・並べ替え (#193)
- ページ回転（90°/180°/270°）(#207)
- 別 PDF へのページ抽出 (#208)

#### バッチ処理
- フォルダ一括 OCR・エクスポート・保存 (#195)

#### 編集
- 校正辞書：ルールセットの保存・読込・一括適用 (#198)
- ポリライン曲線作成 UI (#205)
- 分割位置の文字境界スナップ＋ホバープレビュー (#288)
- 連続分割モード（Esc キーでキャンセル）(#292)
- 曲線テキストの動的オーバーレイ描画（選択ブロック対応）(#290)

#### 保存 / PDF
- SaveDialog 圧縮プリセット (#206)
- 共有ユーティリティ `writeFileChunked` / `writeFileAtomically` (#210)
- 自動アップデーター（`tauri-plugin-updater`）配線 (#274)
  - 製品名を `Peco` に変更
  - updater アセットパターン整合

### Changed

#### 検索・ハイライト
- 検索ヒットのオーバーレイ強調表示と前後ナビゲーション (#196)

#### ストア / アーキテクチャ
- ストアを infra / viewer / search スライスに分割 (#271, #278 ほか)
- IDB I/O を `usePageManagement` フックへ委譲 (#254)
- `pageOrder` をストア正規表現として一元管理（store-canonical 化）(#209)

#### PDF 互換性
- Acrobat 7 互換のため TJ 演算子を Tj に正規化、曲線グリフのワードブレーク対応 (#1)

### Fixed

#### 保存の整合性（PCT-002, 011, 034〜039）
- PDF 保存 Worker のリクエストに `pageOrder` が含まれず、ページ順変更が反映されない問題 (PCT-002)
- 保存時に `PecoToolBBoxes` メタが新表示順にリマップされず、再読込で別ページの OCR 枠が復元される問題 (PCT-011)
- 非 identity `pageOrder` の PDF 保存後もストア側 `pageOrder` が古いままで、2 回目保存で再度並べ替え・削除され得る問題 (PCT-034)
- dirty ページなしの削除・並べ替え保存が元 PDF バイトをそのまま返し、構造変更を落とす問題 (PCT-035)
- 保存中 await 後に古い `document.pages` と新しい `pageOrder` が混在し、別物理ページへ dirty を適用する問題 (PCT-037)
- 保存後 pageOrder 正規化で構造履歴だけ消し、古い display index の undo が別ページを上書きする問題 (PCT-038)
- 保存中のポスト・スナップショット編集が保存後の `lastSavedActionIndex` / `isDirty` 更新で保存済み扱いになる問題 (PCT-039)

#### OCR の整合性（PCT-001, 005〜009, 025〜030）
- `currentPageIndex` / `pageOrder` / 元 PDF ページインデックスの混同によりページ削除・移動後の OCR/表示/保存対象がずれる問題 (PCT-001)
- OCR 中の保存で、OCR 完了後の変更が一時変更クリアと競合する問題 (PCT-005)
- OCR キャンセル後に結果反映直前のキャンセルチェックがなく、キャンセル後もページを書き換える問題 (PCT-006)
- 全ページ/範囲 OCR の既存 OCR 確認が IDB 退避ページを見ず、未ロードページの OCR 有無を誤判定する問題 (PCT-007)
- OCR current-page の regression テストが旧 `imagePath` 契約のままで現行 `imageBytes` 実装を検証できていなかった問題 (PCT-009)
- `loadPage` が pageOrder 変更後もソースインデックスで IDB 一時変更を読み、退避ページの OCR/編集が別ページに混入する問題 (PCT-025)
- `clearOcrAllPages` が IDB 退避ページへ空 OCR 状態を書かず、未ロードページの OCR が復活する問題 (PCT-026)
- `clearOcrAllPages` の IDB 空 OCR 書き込みが既存 pending save を待たず、古い OCR が後勝ちして復活する問題 (PCT-028)
- LRU 保存失敗ロールバックが旧 OCR をメモリへ復活させる問題（generation guard で対応）(PCT-030)

#### ページ管理・IDB（PCT-029, 031, 032）
- `usePageManagement` 経由のページ削除・移動 IDB rename/delete が pending tracking されず保存/読込と競合する問題 (PCT-029)
- 同一ティックのページ削除・移動連打で IDB rename/delete が競合する問題（hook ローカル操作キューで対応）(PCT-031)
- IDB delete/rename ヘルパーが失敗を握り潰し `lastIdbError` へ伝播しない問題 (PCT-032)

#### サムネイル（PCT-010, 012〜024, 033）
- 別ウィンドウの `ThumbnailWindow` が `pageOrder` を Worker へ渡さず、ページ移動後のサムネイルがずれる問題 (PCT-010)
- main ThumbnailPanel で pageOrder 変更前の旧 Worker 応答が変更後の pending を解決し得る問題（requestId ガード）(PCT-012)
- ファイル切替前の旧 Worker 応答が新ファイルの pending へ混入し得る問題（requestId / file epoch ガード）(PCT-013, 015)
- `ThumbnailWindow` の stale response 防止が機能していなかった問題（requestId ガード）(PCT-014)
- `ThumbnailWindow` の LOAD_PDF 中に pageOrder 変更が来ると `isPdfReady=false` のままキューが詰まる問題 (PCT-016)
- main ThumbnailPanel が `documentEpoch` を購読せず、同一 filePath 更新で旧 PDF/cache を使い続ける問題 (PCT-017)
- `useThumbnailWindow` が `documentEpoch` を通知せず、別ウィンドウが同一 filePath 更新を再読込できない問題 (PCT-018)
- `ThumbnailWindow` の file-opened で listener Map をクリアし、既存 item が再購読しない問題 (PCT-019)
- `ThumbnailWindow` の Worker エラー時に LOAD_PDF 待ち Promise が解決されない問題 (PCT-020)
- `ThumbnailWindow` unmount 時に保持済み ObjectURL をリボークしない問題 (PCT-021)
- `thumbnail.worker` で LOAD_PDF 中に `activeRenders` を 0 へ戻すため、旧 render 完了後に負数化する問題 (PCT-022)
- main ThumbnailPanel のキュー重複判定が O(n) で、大量ページ高速スクロール時に詰まりやすい問題（Set による O(1) 化）(PCT-023)
- `ThumbnailWindow` が大容量 PDF を Worker 数ぶん ArrayBuffer 複製し、メモリピークが大きい問題（Worker が URL を直接ロード）(PCT-024)
- 別ウィンドウの `ThumbnailWindow` がページ削除後の `totalPages` を更新せず、削除済みサムネイルを選べる問題 (PCT-033)

#### バッチ保存（PCT-036）
- フォルダ/バッチ OCR 保存が OCR 完了直後の `isOcrRunningRef` にブロックされ、overwrite/sidecar 保存に失敗する問題 (PCT-036)

#### キーボードショートカット（PCT-003, 008）
- `Ctrl+0` 実行時にページ寸法未ロードだと `isAutoFit` だけ立って zoom が更新されない問題 (PCT-003)
- `Ctrl+0` が日本語配列/テンキー等で `e.key === '0'` にならずショートカットが発火しない問題 (PCT-008)

#### E2E テスト（PCT-027）
- Playwright E2E `ribbon.spec.ts` の Help タブ期待文言が実 UI とズレていた問題 (PCT-027)

#### テスト基盤（PCT-040）
- `tauriCapabilityIntegrity` の mkdir ガードが #285 (byte-based OCR) による JS 側 mkdir 撤廃後も誤失敗し、広域 `npm test` が赤くなる問題（条件付きガードで対応・runtime 実害なし）(PCT-040)

### Performance

- `replaceTextBatch` による一括テキスト置換の高速化 (#213)
- 不要な再描画抑制のための debounce 導入 (#222)
- per-glyph save/restore 呼び出し削減 (#240)
- diff scan cap によるスキャン上限制御 (#249)
- main ThumbnailPanel のキュー重複判定を O(n) から O(1) に改善（Set 活用）(PCT-023)
- `ThumbnailWindow` の大容量 PDF メモリピーク削減（ArrayBuffer 複製廃止）(PCT-024)

### Security

- `fs:allow-mkdir` capability を削除（#285 で JS 側 mkdir 撤廃済み・最小権限原則）(PCT-040, RC Hardening)
- 保存原子性の強化: `replace_pdf_file`（Rust）の atomic-replace コアをテスト注入可能な形に抽出し、temp→target 移動失敗時の元ファイル復元と復元失敗時のバックアップパス保持を cargo テストで検証（RC Hardening）

---

## [1.6.3] - (前回リリース)

これ以前の変更履歴は `git log v1.6.3` を参照してください。

---

[Keep a Changelog]: https://keepachangelog.com/ja/1.1.0/
[Semantic Versioning]: https://semver.org/lang/ja/
[2.0.21]: https://github.com/ichiperon/pecotool_V2/compare/v2.0.20...v2.0.21
[2.0.20]: https://github.com/ichiperon/pecotool_V2/compare/v2.0.19...v2.0.20
[2.0.19]: https://github.com/ichiperon/pecotool_V2/compare/v2.0.18...v2.0.19
[2.0.15]: https://github.com/Ryo_Jonishi/pecotool_v2/compare/v2.0.14...v2.0.15
[2.0.14]: https://github.com/Ryo_Jonishi/pecotool_v2/compare/v1.6.3...v2.0.14
