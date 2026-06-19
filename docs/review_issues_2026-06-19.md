# Review Issues 2026-06-19

v2.0.21 に対するアプリ全体レビュー（ユーザー指定の最低保証5軸）の結果と issue 記録。

## レビュー対象・最低保証軸

| 軸 | 内容 |
| --- | --- |
| #1 | PDFの読み込み・保存が問題なく行われる |
| #2 | OCRの文字を編集しユーザーが保存できる |
| #3 | OCRの位置をユーザーが編集できる |
| #4 | 編集したものが一字一句抜けなく保存できる（負荷があっても） |
| #5 | ツール上で表示されているBBの位置とPDFのBBの位置が狂わない |

## 体制（ラウンドA・静的レビュー / 全 Opus）

| 担当 | 軸 | 結果 |
| --- | --- | --- |
| 🏴‍☠️ マリン (reviewer) | #5 / #3 / 位置補正 | P0=0。補正OFF恒等性は厳格に担保。P1=2（回転/縦書きの方向未検証）、P2=2、設計事実1 |
| 🦆 スバル (reviewer_architecture) | #1 / PCT-100 | P0=0。両経路等価性は構造的に担保。P2=2 |
| ⚔️ ノエル (reviewer_readability) | #2 / PCT-104 | P0=0。sonnet先行P1疑い（高速undo混線）は否定。別経路でP1=1（保存中undo）、P2=2 |
| 💚 るしあ (reviewer_performance) | #4 | P0=0。文字抜け主犯は塞がれている。P1=1（全ページ適用1ページ失敗で全保存中断）、P2=1 |
| 🎤 AZKi (security) | 保存IPC/fs/updater | P0/差し戻し=0。署名検証有効。P2=3、注意喚起1 |
| 🍑 ねね (performance) | #1/#4 性能 | P0=0。サムネ/LRU/描画は線形担保。P1=2（全ページ適用の逐次ロード/メモリ未計測） |

**静的レビューの範囲で P0（保証軸の確実な破壊）= 0 件。** 既存ユーザー（位置補正OFF）は無傷。リスクは v2.0.19〜2.0.21 で追加された「OCR位置補正の全ページ適用」経路に集中。Orchestrator が現物で裏取り済み（後述）。

---

## Open

| ID | Priority | Issue | 軸 | Owner | Status |
| --- | --- | --- | --- | --- | --- |

（ラウンドAの P1 はすべてクローズ。下記 Closed 参照）

## Closed（今回修正分・再レビュー通過）

| ID | Priority | Issue | Owner | Closed By |
| --- | --- | --- | --- | --- |
| PCT-106 | P1 | 全ページ適用 `loadAllPagesWithTextBlocks` が1ページの抽出失敗で全体 reject → 保存丸ごと中断（可用性） | るしあ発見 / ぺこら / マリン | ループ内 per-page try-catch でフォールバック。失敗ページは実 textBlocks を持つ existing のみ流用、無ければ Map 非投入＝元PDFのテキスト層を温存（マリン再指摘で「未抽出PageDataの空上書き」懸念を潰し `existing.textBlocks.length>0` ガード追加）。all-or-nothing は atomic replace が担保。失敗時 showToast。useFileOperations 64 passed。マリン承認 |
| PCT-107 | P1 | OCR位置補正の回転(90/180/270)・縦書きの方向検証テストが皆無 | マリン発見 / おかゆ | `pdfTextLayerOffsetRotation.test.ts` 新設（横×4回転＋縦×4回転＋offset0不変＝9件）。**逆転なし＝全回転・縦横で表示右下へ一貫を確証**。符号反転ミューテーションで逆転検出能力も自己検証。P0昇格不要。9 passed。おかゆ報告 |
| PCT-108 | P1 | 保存の長い await 中に undo/redo が走るとライブ pageOrder 遅延参照で savePageOrder と乖離→IDBキーズレ（編集が別ページ/欠落）。undo は保存中も遮断されない | ノエル発見 / シオン / ノエル | 遅延 `.then()` 内の `getState().pageOrder` を全経路で排除し、action 時点の pageOrder をクロージャでキャプチャして渡す方式へ統一（`schedulePendingIdbWrite` 第2引数化・`scheduleStructuralUndoRedoIdbSync` の `contentPageOrder` 必須化）。saveDuringEditRace に回帰2本（旧実装で落ちることを実証）。41 passed。ノエル承認・クローズ可明言 |
| PCT-109 | P1 | 全ページ適用が1000ページで分オーダー＋固定600秒タイムアウトの崖＋進捗無表示でフリーズに見える | ねね発見 / ぺこら / マリン | 進捗トースト（1秒間引き・最終ページ必出）＋固定600秒→`max(600_000, totalPages*1500)` の動的timeout。useFileOperations 64 passed。マリン承認 |
| PCT-117 | P1 | 位置補正の既定が 右4mm/下2mm ＝デフォルトON で、保存テキスト層が表示BBから常時ずれる（DSN-01 のユーザー判定「BB一致」に抵触） | ぼたん解析 / フブキ / マリン | 既定を 0/0 に変更（補正機能は opt-in 資産として維持）。zustand persist `version:1`+`migrate` で旧4/2永続値を 0/0 へリセット（他設定は保持）。UI注記・requirements.md/invariants.md 整合。ocrSettings/offset/curve 55 passed。マリン承認 |

## DSN-01（解決）

位置補正は「保存PDFの透明テキスト層の描画座標に焼き込まれる **素の座標平行移動**（ビューア非依存）」とぼたんが確定。`requirements.md:346` 自身が「0/0でBB一致」と明記しており、既定4/2は仕様の自己矛盾だった。**ユーザー判定「ツールBBと保存テキスト層は一致すべき」を受け、PCT-117 で既定 0/0 化により解決。** 補正機能自体は残し、Acrobat等の選択ハイライト微調整が要るユーザーが明示ONできる。

## P2（次スプリント・バックログ）

| ID | Priority | Issue | Owner |
| --- | --- | --- | --- |
| PCT-110 | P2 | 位置補正 offset 値域に上限ガードなし。極端値(例 9999mm)でテキスト層がページ外へ飛び実質テキスト消失に見える。NaNは現値フォールバック済（良）。±20mm 程度で clamp 推奨 | マリン |
| PCT-111 | P2 | 全ページ適用で `existingBBoxMeta` に無いページ/文字は再描画されず欠落しうる（メタ欠損ページの全ページ適用保存）。未編集×メタ無しページは strip しない保護の有無を要確認 | マリン |
| PCT-112 | P2 | `pdfSaverCore.ts` repair経路(bloat検知再描画)で confidence を引き継がず、保存→再オープン→再保存の1サイクルで低信頼ハイライトが一時消失 | スバル |
| PCT-113 | P2 | `lib.rs:909-914` write_pdf_chunk のバリデーション対象が `target`（剥がした名）で実書込は `path`（temp自身）。論理的に安全だが誤読を招く。`path` 自身への validate 1行追加 or 理由コメント明記 | スバル / AZKi |
| PCT-114 | P2 | worker殻 `totalPages ?? pagesMap.size` が main殻（フォールバックなし）と非対称。現契約では到達不能だが PCT-100 等価性原則の綻び | スバル |
| PCT-115 | P2 | `getTemporaryPageData` 旧キーフォールバックが、並べ替え済み未保存のまま PCT-104 版へ更新した初回のみ displayIndex↔source の意味ズレで1ページ分ズレ復元の可能性。リリースノートに「更新前に保存推奨」1行 | ノエル |
| PCT-116 | P2 | `open_pdf_preview`/`run_ocr` の temp 直書きにサイズ上限なし（Webview侵害時DoS）。`open_pdf_preview` の temp は削除されず残置（機密PDF平文残留）。起動時クリーンアップ or サイズ上限推奨 | AZKi |

## P2 対応結果（同日対応）

| ID | 結果 | 対応 |
| --- | --- | --- |
| PCT-110 | **Closed** | `ocrSettingsStore.ts` の offset setter に ±20mm clamp（`OFFSET_LIMIT_MM`/`clampOffsetMm`）。NaN/非有限は現値維持。UIに範囲ヒント追記。テスト U-OS-26〜29 追加。ocrSettings 33 passed |
| PCT-111 | **Closed（修正不要）** | 調査の結果データ消失は不成立。core の strip 対象は `pagesToWrite`（dirtyページ＝実 textBlocks 有り＋existingBBoxMetaエントリ有りの bloat-repair）のみ（pdfSaverCore.ts:1001/1049）。空/未編集ページは strip されず元テキスト層温存。PCT-106 の `textBlocks.length>0` ガードも併存。`dirtyPages` は `isDirty` フィルタ（同954）で、loadPage 由来の未編集ページ（isDirty=false）は対象外 |
| PCT-112 | **Closed** | repair ブロック抽出（pdfSaverCore.ts:1077-1093）で confidence（0..1有限）を引き継ぐよう修正。永続化条件（同1146）と整合。pdfSaver 46 passed |
| PCT-113 | **Closed** | `lib.rs` write_pdf_chunk で書込先 `path` 自身にも `validate_allowed_resolved_path` を追加（自己完結検証）＋ target 側検証の理由コメント明記。cargo 50 passed |
| PCT-114 | **Closed** | worker殻の `?? pagesMap.size` フォールバックは直接呼び出し/テスト契約で実在するため維持しつつ、main殻との非対称理由をコメント明記（本番経路では到達せず main と等価）。pdfSaver 46 passed |
| PCT-115 | **記載化** | リリースノート記載事項として下記「リリースノート記載事項」に集約 |
| PCT-116 | **Closed** | `lib.rs` temp直書き（write_ocr_temp_bytes/open_pdf_preview）に 500MB 上限ガード＋起動時 `cleanup_stale_ocr_temp_files`（`peco_ocr_*`/`peco_ocr_preview_*` を掃除）を setup フックから呼出し。cargo 50 passed |

## リリースノート記載事項（次リリース時に明記）

- **PCT-117**: アプリ更新時、OCRテキスト層の位置補正の既定値を 右4mm/下2mm → 0/0 にリセットします（ツール表示のBB枠と保存PDFのテキスト層を一致させるため）。補正が必要な場合はOCR設定で再設定してください。
- **PCT-115**: ページの並べ替えを未保存のまま本バージョンへ更新すると、更新直後の初回のみ一時退避した編集が1ページ分ずれて復元される可能性があります。**更新前に保存することを推奨**します。

---

## Orchestrator 裏取り（自己申告でなく実コードで確認）

- **PCT-106 確定**: `useFileOperations.ts:242-253` のループ内 `await loadPage(...)`（249行）は try-catch 無し。1ページ失敗で `loadAllPagesWithTextBlocks` 全体が reject。
- **PCT-107**: offset は `...rotationCm` の後に `translate(bbox.x + textOffsetDx, baselineY - textOffsetDy)`（pdfSaverCore.ts:1271/1294/1322）で加算。bbox/baselineY は viewport整列フレーム（#71）なので設計上は回転に依らず screen 方向一貫の見込み。ただし回転×補正の検証テストが存在しない（pdfTextLayerOffset.test.ts は R=0・横書きのみ）。テスト追加で確証/否定する。
- **PCT-108 到達可能性確認**: `useKeyboardShortcuts.ts:53-55` の undo/redo は `!isEditing` のみガードで、保存中（isSaving）でも発火する。保存の await 中に並べ替え undo を打てば pageOrder 乖離は理論上発生する。

## 自動テスト状況（修正後・最終）

- `npm run test:critical`（pdf/state acceptance）: **exit 0（全緑）**
- 広域 `npm test`（unit/components/integration）: **2105 passed / 131ファイル（exit 0）**
- `cargo test`（Rust）: **exit 0（全緑）**
- Playwright E2E（主要フロー: pdfCanvas/ocrEditor/saveFlow/undoRedoFlow/editTab）: **25 passed**（実 dev UI 駆動）
- 新規 `pdfTextLayerOffsetRotation.test.ts`（PCT-107）: **9 passed**（回転/縦書きの位置補正方向 一貫を確証）

## 自動化と手動の切り分け（ユーザー指摘「Playwrightで自動化できるのでは」への検証結果）

- **保存側 #5 は完全自動化**: テキスト層の描画座標と回転/縦書きの offset 方向を jsdom 統合テストで検証（実 pdf-lib/pdfjs で content stream を再パース）。bboxメタ往復は無変換＝恒等。
- **UI フロー（#1読込・#2編集・#3カード操作・保存・undo/redo）は Playwright E2E で自動化**（25件緑）。
- **真に手動が残るのは2点のみ**:
  1. 実 paddleocr バイナリ（Rust IPC）での OCR 実行 — tauri build 実機が必要
  2. 実キャンバス上の BB 描画位置の目視 — E2Eハーネスは PDF 描画をモックするため canvas ピクセル/幾何の検証は不可（実機 or tauri-driver が必要）。位置補正ON時の外部ビューア目視も含む。

## Go/NoGo（最終）

**静的レビュー P0=0、検出 P1=5件すべて修正・再レビュー通過・クローズ、自動テスト4種＋E2E 全緑。**
→ **自動検証範囲では Go 相当。** 残る出荷ゲートは実機手動2点（下記）のみ。

- [x] PCT-106 修正・再レビュー通過（マリン承認、existing流用ガード追加）
- [x] PCT-107 回転/縦書き方向検証テスト追加 → 9件緑・逆転なし（P0昇格不要）
- [x] PCT-108 修正・再レビュー通過（ノエル承認・クローズ可明言）
- [x] PCT-109 修正・再レビュー通過（マリン承認）
- [x] PCT-117 既定0/0化で DSN-01 解決（ユーザー判定「BB一致」に整合）
- [ ] 実機手動①: tauri build で実 paddleocr OCR→編集→保存→再起動→再オープンの往復（A-1/A-2/C-1 相当）
- [ ] 実機手動②: 既定0/0保存PDFを外部ビューアで開き、テキスト層がツール表示BB位置と一致するか目視（補正ONにした場合の回転PDF含む）
