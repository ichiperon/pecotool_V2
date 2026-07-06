# Discovery ラウンド1 記録：保存・BB整合性

- 実施日: 2026-06-26
- 親計画: `docs/plan/save-bb-integrity-review-loop.md`
- 手法: Workflow で9観点並列バグ狩り（finder=sonnet）→ 既存オープンissue突合・重複排除（triage=opus）→ NEW(P1/P2) を既定refuteで敵対的検証（verify=opus）。
- ベースライン（健全）: `test:critical` 119 passed/1 skipped + 135 passed、帳票ツール 498 passed。

## 数字
33 候補 → worklist 29件 → NEW(P1/P2) 16件を検証 → **is_real 4件** → **3 issue起票**（△バグとその欠落テストは1件に統合）。

## 起票した確定NEW（敵対的検証 is_real=true）

| issue | 内容 | 保証 | 区分 | 検証後 |
|---|---|---|---|---|
| #388 (PCT-158) | `decodeRawStream` が配列形式 `/Filter [/FlateDecode]` を inflate せず null → BBoxメタが空`{}`で永続上書き（外部ツール再保存時のOCR BBox喪失） | 3 | D | P1→**P2/medium**（発火前提が外部ツール経由に限定） |
| #389 (PCT-159) | `normalizeNumeric("△-50000")` → `"--50000"` 値破壊＋`normalize.test` 欠落 | 3 | D | P1→**P2/medium**（△＋明示マイナスの冗長表記限定） |
| #390 (PCT-160) | adjustOffsetモードで矢印キーが `nudgePageOffset` と `goToNextPage` を同時発火 | 7 | D | **P2/severity:high**（機能破綻・損失なし） |

> 重要: 今回のNEWバッチに**確定P1はなし**。両P1候補とも「実在するが発火条件が狭い」と検証で降格。緑＝出荷可ではない（計画書 §2 のD/M分離どおり）。

## 反証で却下されたNEW（12件・再レビューで再提出しないための記録）

| 候補 | 却下理由（要点） |
|---|---|
| stripTextBlocks 未閉BTがEOFまで全描画演算子消去 | BT「前」の `q cm ` は実際は保持される＝症状の読み違い。未閉BTは不正PDF限定で正常経路では発火しない |
| writePecoToolBBoxMeta 孤児ストリーム蓄積 | 保存直後 `sweepUnreachableObjects`(pdfReachabilityGc) が到達不能旧ストリームを必ず削除（issue #96 対処済・コメントも明示） |
| curve区切りスペースTm重複でword-break喪失 | （検証で否定）|
| sanitizeText が LF/CR 残しmulti-line分割 | （検証で否定・font依存M）|
| 全角プラス未変換でformula injection前置 | （検証で否定）|
| OffsetAdjustOverlay stale geom redraw | 下層PDF canvasも旧ページ表示中で整合、次フレームの[geom]effectで是正。永続誤位置にならない |
| ResizeObserver deps に currentPage | （検証で否定）|
| useReportOcr pageOffsets stale snapshot | （検証で否定）|
| test-gap 4件（item.transform chain/LRU再編集/C04/lruIdbRoundtrip skipIf）| （検証でis_real=false。ただしMMP拡張の新規テストとして計画§4で別途扱う価値あり）|

## 既存issueと重複/関連（DUP/RELATED・起票せず／既存を確認・補強）

| dedup | 既存 | 今回の補足（file:line・失敗テスト案つき） |
|---|---|---|
| **RELATED→却下** | #367（回転2回保存で /Rotate ドリフト） | ~~縦書き+R=90/270 の座標ズレ~~ → **Codex＋Claude skeptic 両者一致で NOT-REAL（誤検知）**。縦書きパスも横書きと同一 `rotationCm`（L1389 vs L1446）・同一 y反転（L1385 vs L1442）を使い回転を剛体外側cmで被せるため90°ズレは起きない。提案テストの期待値（PDF_y≈200・reduce）が回転物理として誤り（実際は PDF_x が advance）。**唯一の残課題は test-gap**＝縦書き×回転の回帰テスト未整備（→ MMP拡張で正しい期待値のテストを追加）|
| RELATED | #367 | `pdfSaverRotateOcr.test.ts:137-163` が horizontal固定で vertical+回転の座標を未検証（test-gap） |
| **DUP** | #360（pecoStore非同期ガード残穴） | `replaceText(scope='all')` が `waitForPendingIdbSaves` 前に `getAllTemporaryPageData` を読み、LRU退避ページが一括置換から無音スキップ→保存欠落（`pecoStore.ts:1213-1239`）。保証6・P1相当 |
| RELATED | #360 | `scheduleClearOcrAllPagesIdbWrite` 内でライブ pageOrder を遅延読み（`pecoStore.ts:160-193`） |
| RELATED | #361（保存フロー競合ガード非対称） | `remapTemporaryPageEntries` 失敗をサイレントcatchで握り潰し stale dirty IDB残留→再保存（`useFileOperations.ts:864-869`） |
| RELATED | #362（Canvasマウス堅牢化） | PdfCanvas 選択BB自動スクロールが pageRotation 無視＋deps欠落（`PdfCanvas.tsx:237-261`） |
| **DUP** | #366（golden 2サイクルが再構築になってない） | `goldenMasterLargeScale.test.ts:276-293` が cycle-2 で bboxMeta再構成経路を通らず元docForSave再利用 |

## 次アクション（優先順）
1. ~~#367-RELATED 縦書き+回転 座標ズレを検証~~ → **完了: Codex＋Claude 両者一致で NOT-REAL（コード正常）**。残るは縦書き×回転の回帰テスト追加のみ（MMP拡張へ）。
2. **Phase2 修正ループ: 起票3件（#388/#389/#390）を failing-test-first で**。#390 は再現が明確で着手容易。clean tree（report-tool・pdfPecoToolMetadata は未コミットWIPと非重複）。
3. MMP拡張（計画§4）: 縦書き×回転テスト（正しい期待値）＋反証された test-gap 群（item.transform chain 等）を N-4/N-2/N-5 に統合。
4. DUP/RELATED は既存issue（#360/#361/#362/#366/#367）に file:line と失敗テスト案をコメント補強（任意・要承認）。**#360 の replaceText(scope='all') LRU退避ページ保存欠落は実P1相当だが pecoStore.ts が未コミットWIP中のため、WIP確定後に着手**。
