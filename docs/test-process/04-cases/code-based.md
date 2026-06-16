# PecoTool v2 テストケース仕様書 — Code-Based (Unit / Integration / Component)

> Phase 4: テストケース仕様
> 作成日: 2026-06-03
> 前提資料: `docs/test-process/02-analysis.md` / `docs/test-process/03-design.md`
> 対象バージョン: v2.0.7（Tauri v2 + React 19 + zustand）※2026-06-03 作成時点。現行は v2.0.21

---

## 凡例

| 列 | 説明 |
|---|---|
| ID | `U-XX-NN` = Unit, `I-XX-NN` = Integration, `C-XX-NN` = Component |
| 対象 | モジュール / 関数名 |
| 観点 | テストが検証する単一の振る舞い |
| 優先度 | Critical / High / Medium / Low |
| 状態 | **実装済** = 既存テストでカバー済み / **未実装** = 新規追加が必要 |
| 場所 / 参考 | 実装済みの場合はファイル名(行番号)、未実装の場合は追加先ファイル提案 |

---

## 1. infraStore（Unit）— 優先度: High（最大の抜け穴）

| ID | 対象 | 観点 | 優先度 | 状態 | 場所 / 参考 |
|---|---|---|---|---|---|
| U-IS-01 | `infraStore.bumpDocumentEpoch` | openDocument 呼び出しで documentEpoch が 1 増加する | High | **未実装** | `infraStore.test.ts` に追加 |
| U-IS-02 | `infraStore.bumpDocumentEpoch` | closeDocument 呼び出しで documentEpoch が 1 増加する（単調増加） | High | **未実装** | `infraStore.test.ts` に追加 |
| U-IS-03 | `infraStore.bumpDocumentEpoch` | 複数回連続呼び出しで documentEpoch が累積増加する | High | **未実装** | `infraStore.test.ts` に追加 |
| U-IS-04 | `infraStore.bumpDocumentEpoch` | epoch 変化後に currentPageProxy が null にリセットされる | High | **実装済** | `pecoStore.test.ts:126` (間接カバー) |
| U-IS-05 | `infraStore.currentPageProxy` | expectedKey が一致する場合のみ proxy を受理する | High | **未実装** | `infraStore.test.ts` に追加 |
| U-IS-06 | `infraStore.currentPageProxy` | expectedKey が不一致の場合は proxy 更新を拒否する（race 防止） | High | **未実装** | `infraStore.test.ts` に追加 |
| U-IS-07 | `infraStore.pageAccessOrder` | アクセス時に pageIndex が先頭に移動する（LRU） | High | **未実装** | `infraStore.test.ts` に追加 |
| U-IS-08 | `infraStore.pageAccessOrder` | MAX_CACHED_PAGES 到達時に末尾 pageIndex が退避される | High | **未実装** | `infraStore.test.ts` に追加 |
| U-IS-09 | `infraStore.pageAccessOrder` | 同一 pageIndex への再アクセスで重複しない（順序更新のみ） | High | **未実装** | `infraStore.test.ts` に追加 |
| U-IS-10 | `infraStore.pendingRestoration` | set/clear が正しく機能する | Medium | **未実装** | `infraStore.test.ts` に追加 |
| U-IS-11 | `infraStore.lastIdbError` | IDB エラー発生時に lastIdbError に格納される | High | **未実装** | `infraStore.test.ts` に追加 |
| U-IS-12 | `infraStore.lastIdbError` | 初期値が null である | Medium | **未実装** | `infraStore.test.ts` に追加 |

---

## 2. viewerStore（Unit）— 優先度: Medium

| ID | 対象 | 観点 | 優先度 | 状態 | 場所 / 参考 |
|---|---|---|---|---|---|
| U-VS-01 | `viewerStore.setDrawingMode` | drawing=true にすると isDrawingMode が true になる | Medium | **未実装** | `viewerStore.test.ts` に追加 |
| U-VS-02 | `viewerStore.setDrawingMode` | drawing=true にすると isSplitMode が false になる（排他） | Medium | **未実装** | `viewerStore.test.ts` に追加 |
| U-VS-03 | `viewerStore.setDrawingMode` | drawing=true にすると isCurveMode が false になる（排他） | Medium | **未実装** | `viewerStore.test.ts` に追加 |
| U-VS-04 | `viewerStore.setSplitMode` | split=true にすると isDrawingMode が false になる（排他） | Medium | **未実装** | `viewerStore.test.ts` に追加 |
| U-VS-05 | `viewerStore.setCurveMode` | curve=true にすると isDrawingMode, isSplitMode が false になる（排他） | Medium | **未実装** | `viewerStore.test.ts` に追加 |
| U-VS-06 | `viewerStore.setRangeOcrMode` | rangeOcr=true にすると他のモードが false になる（排他） | Medium | **未実装** | `viewerStore.test.ts` に追加 |
| U-VS-07 | `viewerStore.setDrawingMode` | 同一 mode を 2 回 true にしても冪等（isDrawingMode=true のまま） | Medium | **未実装** | `viewerStore.test.ts` に追加 |
| U-VS-08 | `viewerStore.resetViewerState` | 全モードフラグが false にリセットされる | Medium | **未実装** | `viewerStore.test.ts` に追加 |
| U-VS-09 | `viewerStore.resetViewerState` | zoom は変更されない（リセット対象外） | Medium | **未実装** | `viewerStore.test.ts` に追加 |
| U-VS-10 | `viewerStore` zoom | zoom=0.1（最小）でクランプが発動する | Medium | **未実装** | `viewerStore.test.ts` に追加 |
| U-VS-11 | `viewerStore` zoom | zoom=5.0（最大）でクランプが発動する | Medium | **未実装** | `viewerStore.test.ts` に追加 |

---

## 3. searchStore（Unit）— 優先度: Low

> `searchHitNavigation.test.ts` は純粋関数（nextHitIndex / prevHitIndex）を検証。searchStore の action 直接呼び出しテストは別途必要。

| ID | 対象 | 観点 | 優先度 | 状態 | 場所 / 参考 |
|---|---|---|---|---|---|
| U-SS-01 | `searchStore.setSearchTerm` | searchTerm 変更時に hitIndex が 0 にリセットされる | Low | **未実装** | `searchStore.test.ts` に追加 |
| U-SS-02 | `searchStore.nextSearchHit` | hitIndex が totalHits-1 → 0 にラップアラウンドする | Low | **実装済** | `searchHitNavigation.test.ts:nextHitIndex` (純粋関数カバー) |
| U-SS-03 | `searchStore.prevSearchHit` | hitIndex が 0 → totalHits-1 にラップアラウンドする | Low | **実装済** | `searchHitNavigation.test.ts:prevHitIndex` (純粋関数カバー) |
| U-SS-04 | `searchStore.nextSearchHit` | totalHits=0 のとき index が 0 のまま変化しない | Low | **実装済** | `searchHitNavigation.test.ts` |
| U-SS-05 | `searchStore.prevSearchHit` | totalHits=0 のとき index が 0 のまま変化しない | Low | **実装済** | `searchHitNavigation.test.ts` |
| U-SS-06 | `searchStore` | 初期状態で searchTerm="" / hitIndex=0 である | Low | **未実装** | `searchStore.test.ts` に追加 |

---

## 4. pecoStore（Unit）— 優先度: Critical

| ID | 対象 | 観点 | 優先度 | 状態 | 場所 / 参考 |
|---|---|---|---|---|---|
| U-PO-01 | `pushAction` | undoStack に action が積まれる | Critical | **実装済** | `pecoStore.test.ts:108` |
| U-PO-02 | `pushAction` | pushAction で redoStack がクリアされる | Critical | **実装済** | `pecoStore.test.ts:117` |
| U-PO-03 | `undoAction` | undoStack が空の場合は no-op | Critical | **実装済** | `pecoStore.test.ts` |
| U-PO-04 | `undoAction` | undo 後に redoStack に action が移る | Critical | **実装済** | `pecoStore.test.ts` |
| U-PO-05 | `redoAction` | redo 後に undoStack に action が戻る | Critical | **実装済** | `pecoStore.test.ts` |
| U-PO-06 | `pushAction` | undoStack 上限 100 に達すると最古エントリが押し出される | Critical | **実装済** | `pecoStore.test.ts` |
| U-PO-07 | `updatePageData` | dirty=true になり undoStack に記録される | Critical | **実装済** | `pecoStore.test.ts` |
| U-PO-08 | `updatePageData` | LRU 退避ページへの updatePageData が正しく処理される | High | **実装済** | `pecoStore.test.ts` |
| U-PO-09 | `deletePages` | 対象ページが削除され pageOrder が更新される | High | **実装済** | `pecoStore.test.ts` |
| U-PO-10 | `movePage` | pageOrder が期待通りに並び替えられる | High | **実装済** | `pecoStore.test.ts` |
| U-PO-11 | `rotatePages` | 対象ページの rotation が更新され dirty になる | High | **実装済** | `pecoStore.test.ts` |
| U-PO-12 | `clipboard` | copyToClipboard / pasteFromClipboard が round-trip する | Medium | **実装済** | `pecoStore.test.ts` |
| U-PO-13 | `document=null` | undo 操作が no-op になる（クラッシュしない） | Critical | **未実装** | `pecoStore.test.ts` に追加 |

---

## 5. pdfSaver（Unit + Integration）— 優先度: Critical

| ID | 対象 | 観点 | 優先度 | 状態 | 場所 / 参考 |
|---|---|---|---|---|---|
| U-PS-01 | `buildPdfDocument` | dirty=0 + meta なし → byte equal（short-circuit） | Critical | **実装済** | `pdfSaverShortCircuit.test.ts:32` |
| U-PS-02 | `buildPdfDocument` | dirty=0 + meta あり → short-circuit しない | Critical | **実装済** | `pdfSaverShortCircuit.test.ts` |
| U-PS-03 | `buildPdfDocument` | dirty=1+ → 通常保存（バイト変化あり） | Critical | **実装済** | `pdfSaverShortCircuit.test.ts` |
| U-PS-04 | `savePDF` | no-op 判定後に writeFile が呼ばれない | Critical | **実装済** | `pdfSaver.test.ts` |
| I-PS-01 | `pdfSaver` round-trip | save → reload で textBlocks が保全される | Critical | **実装済** | `saveReloadRoundtrip.test.ts` |
| I-PS-02 | `pdfSaver` Acrobat互換 | /ID 保持（trail ID extraction + overwrite） | Critical | **実装済** | `pdfSaverIdPreservation.test.ts` |
| I-PS-03 | `pdfSaver` Acrobat互換 | curve glyph BT...ET per-glyph word-break (#188) | Critical | **実装済** | `pdfSaverCurveGlyph.test.ts` |
| I-PS-04 | `pdfSaver` compression | 圧縮保存の byte サイズが元ファイルの 1.5 倍以内 | High | **実装済** | `pdfSizeRegression.test.ts` |
| I-PS-05 | `pdfSaver` rotation | OCR + rotation + save で ページ回転が保全される | High | **実装済** | `pdfSaverRotateOcr.test.ts` |
| I-PS-06 | `pdfSaver` multiStream | 複数 content stream の decode 失敗時に graceful fallback | High | **実装済** | `pdfSaverMultiStreamDecodeFailure.test.ts` |
| I-PS-07 | `pdfSaver` savePreset | compression off + dirty なし → no-op（DT-04 行1） | High | **実装済** | `pdfSaverCompressed.test.ts` |
| I-PS-08 | `pdfSaver` fontDedup | フォント重複排除で出力サイズが適正 | High | **実装済** | `pdfSaverFontDedup80.test.ts` |
| I-PS-09 | `pdfSaver` race | 保存中の編集が次回 save に正しく載る（#115/#119） | Critical | **実装済** | `saveDuringEditRace.test.ts` |
| I-PS-10 | `pdfSaver` idempotent | non-dirty 2 回保存で byte equal | High | **未実装** | `pdfSaverIdempotent.integration.test.ts` に追加 |

---

## 6. pdfPecoToolMetadata（Unit + Integration）— 優先度: High

| ID | 対象 | 観点 | 優先度 | 状態 | 場所 / 参考 |
|---|---|---|---|---|---|
| U-PM-01 | `readBBoxMeta` | `/Catalog/PecoToolBBoxes` から読み込む（正常系） | High | **実装済** | `pdfPecoToolMetadata.test.ts` |
| U-PM-02 | `readBBoxMeta` | `/Info/PecoToolBBoxes` legacy fallback（DT-02 行2） | High | **実装済** | `pdfPecoToolMetadata.test.ts` |
| U-PM-03 | `readBBoxMeta` | catalog + legacy 両方あり → catalog 優先（DT-02 行3） | High | **実装済** | `pdfPecoToolMetadata.test.ts` |
| U-PM-04 | `readBBoxMeta` | どちらもなし → 空メタ返却（DT-02 行4） | High | **実装済** | `pdfPecoToolMetadata.test.ts` |
| U-PM-05 | `readBBoxMeta` | FlateDecode 失敗時に例外なく空メタを返す | High | **実装済** | `pdfPecoToolMetadata.test.ts` |
| U-PM-06 | `writeBBoxMeta` | write → read で round-trip | High | **実装済** | `pdfPecoToolMetadata.test.ts` |
| U-PM-07 | `removeLegacyPecoToolBBoxInfo` | legacy /Info エントリが削除される | Medium | **実装済** | `pdfPecoToolMetadata.test.ts` |
| I-PM-01 | `pdfPecoToolMetadata` | curve bbox meta save→reload round-trip | High | **実装済** | `curveBBoxMetaRoundtrip.test.ts` |
| I-PM-02 | `pdfPecoToolMetadata` | non-dirty save でメタが保全される | High | **実装済** | `pdfSaverNonDirtyMetaPreservation.test.ts` |

---

## 7. pdfTrailerId（Unit）— 優先度: High

| ID | 対象 | 観点 | 優先度 | 状態 | 場所 / 参考 |
|---|---|---|---|---|---|
| U-PT-01 | `extractTrailerId` | 正常な /ID 配列から hex 文字列ペアを取得する | High | **実装済** | `pdfTrailerId.test.ts` |
| U-PT-02 | `extractTrailerId` | /ID 不在の場合に null を返す | High | **実装済** | `pdfTrailerId.test.ts` |
| U-PT-03 | `extractTrailerId` | hex 長 mismatch の場合に null を返す | High | **実装済** | `pdfTrailerId.test.ts` |
| U-PT-04 | `overwriteTrailerId` | 抽出した ID をそのまま overwrite すると byte equal | High | **実装済** | `pdfTrailerId.test.ts` |
| U-PT-05 | `extractTrailerId` | 16 進パース失敗時に例外なく null を返す | High | **実装済** | `pdfTrailerId.test.ts` |

---

## 8. pdfLoader（Unit）— 優先度: High

| ID | 対象 | 観点 | 優先度 | 状態 | 場所 / 参考 |
|---|---|---|---|---|---|
| U-PL-01 | LRU page proxy | キャッシュ内の proxy がヒットする | High | **実装済** | `pdfLoader.test.ts` |
| U-PL-02 | LRU page proxy | MAX_CACHED_PAGES 超過で最古が退避される | High | **実装済** | `pdfLoader.test.ts` |
| U-PL-03 | shared PDF proxy | 同一 filePath で proxy が共有される | High | **実装済** | `pdfLoader.test.ts` |
| U-PL-04 | writing-mode 検出 | vertical writing-mode の PDF を正しく検出する | High | **実装済** | `pdfLoader.test.ts` |
| U-PL-05 | `waitForPendingIdbSaves` | 保存待ちがある場合に解決を待つ | High | **実装済** | `pdfLoader.test.ts` |
| U-PL-06 | IDB キャッシュ | loadPage が IDB キャッシュを利用する | High | **実装済** | `lruIdbRoundtrip.test.ts` (integration) |

---

## 9. tauriFileIO（Unit）— 優先度: High

| ID | 対象 | 観点 | 優先度 | 状態 | 場所 / 参考 |
|---|---|---|---|---|---|
| U-TF-01 | `writeFileChunked` | 正常にチャンク分割で書き込む | High | **実装済** | `tauriFileIO.test.ts` |
| U-TF-02 | `writeFileChunked` | 空 Uint8Array でも write_pdf_chunk を 1 回呼ぶ (#8) | High | **実装済** | `useFileOperations.test.ts` (間接) |
| U-TF-03 | `writeFileAtomically` | EACCES エラー時に isWriteAccessError=true を返す | High | **実装済** | `tauriFileIO.test.ts` |
| U-TF-04 | `readFileSafe` | 読み込み失敗時に null を返す（例外を吸収） | High | **実装済** | `tauriFileIO.test.ts` |
| U-TF-05 | `writeFileAtomically` | 書き込み成功時に temp ファイルが残らない | High | **実装済** | `tauriFileIO.test.ts` |

---

## 10. useOcrEngine（Unit + Integration）— 優先度: High

| ID | 対象 | 観点 | 優先度 | 状態 | 場所 / 参考 |
|---|---|---|---|---|---|
| U-OE-01 | `runOcr` current | current ページに OCR を実行する | High | **実装済** | `useOcrEngine.test.ts` |
| U-OE-02 | `runOcr` all | 全ページに OCR を実行する | High | **実装済** | `useOcrEngine.test.ts` |
| U-OE-03 | `runOcr` epoch cancel | OCR 中にドキュメント切替で epoch が変わりキャンセルされる | High | **実装済** | `useOcrEngine.test.ts` |
| U-OE-04 | text-layer 検出 | 既存テキスト層がある場合にスキップオプションが機能する | High | **実装済** | `useOcrEngine.test.ts` |
| I-OE-01 | `ocrEngineFlow` | OCR → textBlocks 保存 → reload の round-trip | High | **実装済** | `ocrEngineFlow.test.ts` |
| U-OE-05 | `ocrEditFlush` | flush 中のドキュメント切替で結果が破棄される（race） | High | **未実装** | `ocrEditFlush.test.ts` に追加 |

---

## 11. usePageManagement / usePageNavigation（Unit）— 優先度: Medium

| ID | 対象 | 観点 | 優先度 | 状態 | 場所 / 参考 |
|---|---|---|---|---|---|
| U-PM2-01 | `usePageManagement.deletePages` | 引数バリデーション（空配列 → no-op） | Medium | **未実装** | `usePageManagement.test.ts` に追加 |
| U-PM2-02 | `usePageManagement.deletePage` | 削除後の currentPageIndex が範囲内に収まる | Medium | **未実装** | `usePageManagement.test.ts` に追加 |
| U-PM2-03 | `usePageManagement.movePage` | 移動元 = 移動先のとき no-op | Medium | **未実装** | `usePageManagement.test.ts` に追加 |
| U-PM2-04 | `usePageNavigation` | pageIndex=0 で prevPage が no-op（境界値） | Medium | **実装済** | `usePageNavigation.test.ts` |
| U-PM2-05 | `usePageNavigation` | pageIndex=last で nextPage が no-op（境界値） | Medium | **実装済** | `usePageNavigation.test.ts` |

---

## 12. useBackupManagement（Unit）— 優先度: Medium

| ID | 対象 | 観点 | 優先度 | 状態 | 場所 / 参考 |
|---|---|---|---|---|---|
| U-BK-01 | `useBackupManagement.restoreBackup` | 正常な復元フロー | Medium | **未実装** | `useBackupManagement.test.ts` に追加 |
| U-BK-02 | `useBackupManagement.restoreBackup` | 保存中に復元が呼ばれると競合ガードが機能する | Medium | **未実装** | `useBackupManagement.test.ts` に追加 |
| U-BK-03 | `useBackupManagement` | 復元対象バックアップが存在しない場合は no-op | Medium | **未実装** | `useBackupManagement.test.ts` に追加 |

---

## 13. 低レベル PDF ヘルパ（Unit）— 優先度: Medium

| ID | 対象 | 観点 | 優先度 | 状態 | 場所 / 参考 |
|---|---|---|---|---|---|
| U-PH-01 | `pdfFastMetadata` | 正常な /Info メタデータ読み込み | Medium | **未実装** | `pdfFastMetadata.test.ts` に追加 |
| U-PH-02 | `pdfFastMetadata` | 不正バイト列での decode 失敗時に null を返す | Medium | **未実装** | `pdfFastMetadata.test.ts` に追加 |
| U-PH-03 | `pdfLibSafeDecode` | 壊れた FlateDecode stream で例外なく fallback する | Medium | **未実装** | `pdfLibSafeDecode.test.ts` に追加 |
| U-PH-04 | `pdfLibSafeDecode` | 正常な stream を decode できる | Medium | **未実装** | `pdfLibSafeDecode.test.ts` に追加 |
| U-PH-05 | `pdfPecoToolMarkers` | PecoTool マーカーが存在する PDF で true を返す | Medium | **未実装** | `pdfPecoToolMarkers.test.ts` に追加 |
| U-PH-06 | `pdfPecoToolMarkers` | 非 PecoTool PDF で false を返す | Medium | **未実装** | `pdfPecoToolMarkers.test.ts` に追加 |
| U-PH-07 | `pdfVersion` | PDF 1.4 の version を正しく取得する | Medium | **未実装** | `pdfVersion.test.ts` に追加 |
| U-PH-08 | `pdfVersion` | version ヘッダーがない PDF で null を返す | Medium | **未実装** | `pdfVersion.test.ts` に追加 |

---

## 14. pdfClassicXref / pdfReachabilityGc / pdfPageExtractor（Unit + Integration）— 優先度: Medium

| ID | 対象 | 観点 | 優先度 | 状態 | 場所 / 参考 |
|---|---|---|---|---|---|
| U-PX-01 | `ensureDenseClassicXref` | classic xref を dense に変換する | Medium | **実装済** | `pdfClassicXref.test.ts` |
| U-PX-02 | `ensureDenseClassicXref` | 2 回適用で冪等（idempotent） | Medium | **実装済** | `pdfClassicXref.test.ts` |
| I-PG-01 | `sweepUnreachableObjects` | 到達可能オブジェクトが保全される | Medium | **実装済** | `pdfReachabilityGc.test.ts` |
| I-PG-02 | `sweepUnreachableObjects` | 孤立オブジェクトが削除される | Medium | **実装済** | `pdfReachabilityGc.test.ts` |
| I-PG-03 | `compactIndirectObjectNumbers` | 番号が詰められる | Medium | **実装済** | `pdfReachabilityGcWave7.test.ts` |
| U-PE-01 | `extractPagesToNewPdf` | 指定範囲のページが正しく抽出される | Medium | **実装済** | `pdfPageExtractor.test.ts` |
| U-PE-02 | `isPdfEncrypted` | 暗号化 PDF で true を返す | Medium | **実装済** | `pdfPageExtractor.test.ts` |

---

## 15. Integration — race / 後方互換 / 性能（横断）— 優先度: High

| ID | 対象 | 観点 | 優先度 | 状態 | 場所 / 参考 |
|---|---|---|---|---|---|
| I-RC-01 | OCR 中 close | documentEpoch キャンセルで OCR 結果が破棄される | High | **実装済** | `useOcrEngine.test.ts`（unit で確認）|
| I-RC-02 | IDB 保存中 reload | reload 時に pending save が完了するまで待機する | High | **実装済** | `lruIdbRoundtrip.test.ts` (間接) |
| I-RC-03 | DnD 中テキスト編集 | DnD 操作中のテキスト編集で double-write が起きない | Medium | **未実装** | `raceConditions.integration.test.ts` に追加 |
| I-BC-01 | legacy bbox → catalog | legacy bbox PDF を読み込み保存すると catalog に移行される | Medium | **未実装** | `backwardCompat.integration.test.ts` に追加 |
| I-BC-02 | 非 PecoTool PDF | 読み込み・保存時にクラッシュせず bbox 空で返る | Medium | **実装済** | `realPdfDurabilityScenarios.test.ts` (間接) |
| I-BC-03 | 旧 xref 形式 | `ensureDenseClassicXref` 後に Acrobat 互換 | Medium | **実装済** | `pdfClassicXref.test.ts` + `savePdfAcceptanceStrict.test.ts` |
| I-SC-01 | 500 ページ load | 3000ms 以内に表示完了 | Medium | **実装済** | `loadTest500Pages.test.ts` |
| I-SC-02 | 1000 ページ load | LRU 退避が効く規模で save + restore が正常 | Medium | **未実装** | `loadTest1000Pages.test.ts` に追加 |

---

## 16. Component テスト（UI）— 優先度: Medium

| ID | 対象 | 観点 | 優先度 | 状態 | 場所 / 参考 |
|---|---|---|---|---|---|
| C-RB-01 | `Ribbon` Alt+1 | Alt+1 アクセラレータで最初のタブに切り替わる（#277） | Medium | **実装済** | `Ribbon.test.tsx` |
| C-RB-02 | `Ribbon` Alt+2 | Alt+2 アクセラレータで 2 番目のタブに切り替わる | Medium | **実装済** | `Ribbon.test.tsx` |
| C-RB-03 | `Ribbon` ResizeObserver | 幅縮小でボタンが折り畳まれる | Medium | **実装済** | `Ribbon.test.tsx` |
| C-SD-01 | `SaveDialog` a11y | フォーカストラップが機能する | Medium | **実装済** | `SaveDialog.test.tsx` |
| C-SD-02 | `SaveDialog` a11y | Esc キーでダイアログが閉じる | Medium | **未実装** | `SaveDialog.test.tsx` に追加 |
| C-DM-01 | `DiffPreviewModal` | モーダルが開閉する（Esc で閉じる） | Medium | **未実装** | `Modal.test.tsx` に追加 |
| C-OA-01 | `OcrEditor` | 検索フィルタでブロックが絞り込まれる | Medium | **実装済** | `OcrEditor.test.tsx` |
| C-OA-02 | `OcrEditor` DnD | DnD 並べ替え後の order が更新される | Medium | **実装済** | `OcrEditor.test.tsx` |
| C-CV-01 | `PdfCanvas` static | static layer が分離されて再描画されない | High | **実装済** | `pdfCanvasStaticLayer.test.ts` |
| C-CV-02 | `PdfCanvas` overlay | OCR confidence ハイライトが正しく描画される | High | **実装済** | `PdfCanvas` unit tests |
| C-MA-01 | Modals a11y | role / aria-* 属性が正しい | Medium | **実装済** | `ModalsA11y.test.tsx` |
| C-OT-01 | `OnboardingTour` | 4 マスクのステップ遷移が正しい | Low | **実装済** | `OnboardingTour.test.tsx` |
| C-OT-02 | `OnboardingTour` | localStorage 既読フラグでツアーをスキップする | Low | **実装済** | `OnboardingTour.test.tsx` |

---

## 17. カバレッジサマリ

| カテゴリ | 総ケース数 | 実装済 | 未実装 | 備考 |
|---|---|---|---|---|
| Unit（infraStore 新規） | 12 | 1 | 11 | 最優先追加対象 |
| Unit（viewerStore 新規） | 11 | 0 | 11 | #271 分離後の単体 |
| Unit（searchStore 補完） | 6 | 4 | 2 | 純粋関数は実装済み |
| Unit（pecoStore） | 13 | 12 | 1 | document=null null-guard |
| Unit（pdfSaver） | 4 | 4 | 0 | Critical 領域は充足 |
| Integration（pdfSaver） | 10 | 9 | 1 | idempotent 2回保存 |
| Unit（pdfPecoToolMetadata） | 7 | 7 | 0 | 充足 |
| Unit（pdfTrailerId） | 5 | 5 | 0 | 充足 |
| Unit（pdfLoader） | 6 | 6 | 0 | 充足 |
| Unit（tauriFileIO） | 5 | 5 | 0 | 充足 |
| Unit（OCR） | 6 | 5 | 1 | ocrEditFlush race |
| Unit（usePageManagement） | 5 | 2 | 3 | フック層が穴 |
| Unit（useBackupManagement） | 3 | 0 | 3 | 完全未カバー |
| Unit（低レベル PDF ヘルパ） | 8 | 0 | 8 | 直接テスト皆無 |
| Unit + Integration（その他） | 12 | 10 | 2 | race / 後方互換横断 |
| Component | 13 | 11 | 2 | SaveDialog Esc / DiffPreview |
| **合計** | **126** | **81** | **45** | カバー率: **64%** |

---

## 18. Phase 5（実装 wave）優先順位

### Wave 1: Critical 即時追加（未実装 11 件）
- `infraStore.test.ts` — U-IS-01〜U-IS-12（epoch / LRU / race 防止）
- `viewerStore.test.ts` — U-VS-01〜U-VS-11（mode 排他 / reset）
- `pecoStore.test.ts` 追加 — U-PO-13（document=null guard）

### Wave 2: High — フック層 + race 系（未実装 9 件）
- `usePageManagement.test.ts` — U-PM2-01〜U-PM2-03
- `useBackupManagement.test.ts` — U-BK-01〜U-BK-03
- `ocrEditFlush.test.ts` — U-OE-05
- `raceConditions.integration.test.ts` — I-RC-03
- `backwardCompat.integration.test.ts` — I-BC-01
- `pdfSaverIdempotent.integration.test.ts` — I-PS-10

### Wave 3: Medium — 低レベルヘルパ + スケール（未実装 13 件）
- `pdfFastMetadata.test.ts` / `pdfLibSafeDecode.test.ts` / `pdfPecoToolMarkers.test.ts` / `pdfVersion.test.ts`
- `loadTest1000Pages.test.ts` — I-SC-02
- `searchStore.test.ts` 追加 — U-SS-01 / U-SS-06
- `SaveDialog.test.tsx` / `Modal.test.tsx` Component 補完
