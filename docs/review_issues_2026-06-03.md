# Review Issues 2026-06-03

## Open

| ID | Priority | Issue | Owner | Status |
| --- | --- | --- | --- | --- |

## Review Pending

| ID | Priority | Issue | Owner | Status |
| --- | --- | --- | --- | --- |

## Closed

| ID | Priority | Issue | Owner | Closed By |
| --- | --- | --- | --- | --- |
| PCT-003 | P0 | `Ctrl+0` 実行時にページ寸法未ロードだと `isAutoFit` だけ立ってzoomが更新されない | Ctrl+0 Debugger / Sartre | `usePdfViewerState.test.ts` 3 tests passed |
| PCT-008 | P0 | `Ctrl+0` が日本語配列/テンキー等で `e.key === '0'` にならずショートカットが発火しない | Copernicus | `useKeyboardShortcuts.test.tsx` 22 tests passed |
| PCT-009 | P0 | OCR current-page regression test が旧 `imagePath` 契約のままで、現行 `imageBytes` 実装を検証できていない | Hegel | `ocrEngineFlow.test.ts` 24 tests passed |
| PCT-002 | P0 | PDF保存Workerのrequestに `pageOrder` が無く、本番保存経路がページ順変更を反映しない | App Reviewer / Leibniz | `pdfSaver.test.ts` 44 tests passed; `tsc --noEmit` passed |
| PCT-004 | P0 | Acrobat 7でOCRテキスト層が上方向にずれる事象を保存後bbox監査で検出できない | OCR Debugger / Lovelace | `pdfSaver.acrobat7compat.test.ts` + `pdfSaverDescentRatio.test.ts` passed |
| PCT-006 | P1 | OCRキャンセル後に結果反映直前のcancel checkが無く、キャンセル後にページを書き換える可能性がある | App Reviewer / Rawls | `ocrEngineFlow.test.ts` 24 tests passed; `tsc --noEmit` passed |
| PCT-005 | P1 | OCR中の保存で、OCR完了後の変更が保存直後の一時変更クリアと競合する | App Reviewer | `useFileOperations.test.ts` 47 tests passed; `tsc --noEmit` passed |
| PCT-007 | P1 | 全ページ/範囲OCRの既存OCR確認がIDB退避ページを見ず、未ロードページのOCR有無を誤判定する | OCR Debugger / Confucius | `ocrEngineFlow.test.ts` 24 tests passed; `tsc --noEmit` passed |
| PCT-010 | P1 | 別ウィンドウの ThumbnailWindow が `pageOrder` をWorkerへ渡さず、ページ移動後のサムネイルがズレる | Maxwell / Newton | `useThumbnailWindow.test.ts` + `ThumbnailWindow.test.tsx` 8 tests passed; `tsc --noEmit` passed |
| PCT-011 | P0 | `pageOrder` 保存時に既存 `PecoToolBBoxes` メタが新表示順へremapされず、再読込で別ページのOCR枠を復元する | Save Reviewer / Feynman | `pdfSaver.test.ts` 44 tests passed; `tsc --noEmit` passed |
| PCT-001 | P0 | `currentPageIndex` / `pageOrder` / original PDF page index が混同され、ページ削除・移動後のOCR/表示/保存対象がずれる | OCR Debugger / McClintock / Lorentz / Maxwell | `usePageNavigation.test.ts` + `usePdfRendering.test.ts` + `ocrEngineFlow.test.ts` 62 tests passed; `useThumbnailPanel.test.ts` 27 tests passed; `tsc --noEmit` passed |
| PCT-012 | P1 | main ThumbnailPanelでpageOrder変更前の旧Worker応答が、変更後の同じdisplay indexのpendingを解決し得る | Thumbnail Reviewer / Russell | requestId guard; `useThumbnailPanel.test.ts` 31 tests passed |
| PCT-013 | P1 | main ThumbnailPanelでファイル切替前の旧Worker応答が、新ファイルの同じdisplay indexのpendingを解決し得る | Thumbnail Reviewer / Russell | requestId/file epoch guard; `useThumbnailPanel.test.ts` 31 tests passed |
| PCT-014 | P1 | ThumbnailWindowのpageGenerationRefがWorker応答に紐付かず、stale response防止になっていない | Thumbnail Reviewer / Russell | requestId guard; `ThumbnailWindow.test.tsx` 7 tests passed |
| PCT-015 | P1 | ThumbnailWindowでファイル切替前の旧Worker応答が、新ファイルのpendingへ混入し得る | Thumbnail Reviewer / Russell | requestId/file load epoch guard; `ThumbnailWindow.test.tsx` 7 tests passed |
| PCT-016 | P1 | ThumbnailWindow初回LOAD_PDF中にpageOrder変更が来るとisPdfReady=falseのままqueueが詰まる | Thumbnail Reviewer / Russell | separate PDF load epoch; `ThumbnailWindow.test.tsx` 7 tests passed |
| PCT-017 | P1 | main ThumbnailPanelがdocumentEpochを購読せず、同一filePath更新で旧PDF/cacheを使い続け得る | Thumbnail Reviewer / Russell | documentEpoch reload; `useThumbnailPanel.test.ts` 31 tests passed |
| PCT-018 | P1 | useThumbnailWindowがdocumentEpochを通知せず、別ウィンドウが同一filePath更新を再読込できない | Thumbnail Worker / Helmholtz | `useThumbnailWindow.test.ts` 8 tests passed |
| PCT-019 | P1 | ThumbnailWindowのfile-openedでlistener Mapをclearし、既存itemが再購読しない可能性がある | Thumbnail Reviewer / Russell | notify without clearing listeners; `ThumbnailWindow.test.tsx` 7 tests passed |
| PCT-020 | P2 | ThumbnailWindowのWorker error時にLOAD_PDF待ちPromiseが解決されない | Thumbnail Reviewer / Russell | worker error pending resolution; `ThumbnailWindow.test.tsx` 7 tests passed |
| PCT-021 | P2 | ThumbnailWindow unmount時に保持済みObjectURLをrevokeしない | Thumbnail Reviewer / Russell | unmount revoke; `ThumbnailWindow.test.tsx` 7 tests passed |
| PCT-022 | P2 | thumbnail.workerでLOAD_PDF中にactiveRendersを0へ戻すため、旧render完了後に負数化し得る | Thumbnail Reviewer / Russell | render slot accounting fix; thumbnail suite 46 tests passed |
| PCT-023 | P2 | main ThumbnailPanelのqueue重複判定がO(n)で大量ページ高速スクロール時に詰まりやすい | Thumbnail Reviewer / Russell | queueSet de-dupe; `useThumbnailPanel.test.ts` 31 tests passed |
| PCT-024 | P2 | ThumbnailWindowが大容量PDFをworker数ぶんArrayBuffer複製し、メモリピークが大きい | Thumbnail Reviewer / Russell | worker loads URL instead of cloned ArrayBuffer; `ThumbnailWindow.test.tsx` 7 tests passed |
| PCT-025 | P0 | `loadPage` がpageOrder変更後もsource indexでIDB一時変更を読み、退避ページのOCR/編集が別ページに混入し得る | OCR/PageOrder Reviewer | source/display split; OCR/pageOrder suite 80 tests passed |
| PCT-026 | P1 | `clearOcrAllPages` がIDB退避ページへ空OCR状態を書かず、未ロードページのOCRが復活し得る | OCR/PageOrder Reviewer | IDB clear stubs; `pecoStore.test.ts` 151 tests passed |
| PCT-027 | P2 | Playwright E2E `ribbon.spec.ts` のHelpタブ期待文言が実UIとズレ、全E2Eが1件失敗する | E2E Reviewer | Help tab assertion updated; Playwright E2E 74 passed / 1 skipped |
| PCT-028 | P1 | `clearOcrAllPages` のIDB空OCR書き込みが既存pending saveを待たず、古いOCRが後勝ちして復活し得る | OCR/PageOrder Re-review / Mill | afterPending IDB write; IDB suite 175 tests passed |
| PCT-029 | P1 | `usePageManagement` 経由のページ削除/移動IDB rename/deleteがpending trackingされず、保存/読込と競合し得る | OCR/PageOrder Re-review / Mill | hook-side IDB work tracking; `usePageManagement.test.ts` 14 tests passed |
| PCT-030 | P1 | `clearOcrAllPages` 後に古いLRU保存失敗ロールバックが旧OCRをメモリへ復活させ得る | IDB Race Reviewer / Russell | OCR clear generation rollback guard; `pecoStore.test.ts` 151 tests passed |
| PCT-031 | P1 | 同一tickのページ削除/移動連打で初期waitを同時通過し、IDB rename/deleteが競合し得る | Page Management Worker / Arendt | hook-local operation queue; `usePageManagement.test.ts` 14 tests passed |
| PCT-032 | P2 | IDB delete/rename helperが失敗を握り潰し、hook/storeのlastIdbErrorへ伝播しない | IDB Helper Worker / Helmholtz | helper rejection propagation; IDB suite 175 tests passed |
| PCT-033 | P1 | 別ウィンドウの ThumbnailWindow がページ削除後の `totalPages` を更新せず、削除済みサムネイルを選べる | Thumbnail/Worker Reviewer / Volta / Hilbert | page-order payload expanded; thumbnail suite 48 tests passed; re-review LGTM |
| PCT-034 | P1 | 非identity `pageOrder` のPDF保存後もstore側pageOrderが古いままで、2回目保存で再度並べ替え/削除され得る | OCR/PageOrder Reviewer / Carson / Descartes / Planck | save-after-normalize; `useFileOperations` + `pecoStore` 207 tests passed; re-review LGTM |
| PCT-035 | P1 | dirtyページなしの削除/並べ替え保存が元PDF bytesをそのまま返し、構造変更を落とし得る | Release-gate Save Reviewer / Aquinas / Descartes | non-default pageOrder bypasses clean short-circuit; pdf save focus 52 passed / 1 skipped |
| PCT-036 | P1 | フォルダ/バッチOCR保存がOCR完了直後の `isOcrRunningRef` にブロックされ、overwrite/sidecar保存に失敗し得る | UI/E2E Reviewer / Curie / Hilbert | batch save bypass wiring; batch/shortcut/fit focus 41 tests passed; re-review LGTM |
| PCT-037 | P0 | 保存中await後に古い `document.pages` と新しい `pageOrder` が混ざり、別物理ページへdirtyを適用し得る | Save Snapshot Worker / Kepler / Planck | document/pageOrder same-snapshot clone; `useFileOperations.test.ts` 52 tests passed; re-review LGTM |
| PCT-038 | P1 | 保存後pageOrder正規化で構造履歴だけ消し、古いdisplay indexの `update_page(s)` undoが別ページを上書きし得る | Undo/Redo Worker / Einstein / Planck | non-identity normalize clears undo/redo; `pecoStore.test.ts` 155 tests passed; re-review LGTM |
| PCT-039 | P1 | 保存中のpost-snapshot編集/構造変更が保存後 `lastSavedActionIndex` / `isDirty` 更新で保存済み扱いになり得る | Save State Worker / Franklin / Ptolemy | savedActionIndex + post-snapshot dirty guard; `useFileOperations.test.ts` 52 tests passed; re-review LGTM |

## Final Verification

- `npx tsc --noEmit` passed
- `npx vitest run src/__tests__/unit/pecoStore.test.ts src/__tests__/unit/useFileOperations.test.ts --testTimeout=30000 --exclude "**/.claude/**"` passed: 207 tests
- `npx vitest run src/__tests__/unit/pecoStore.test.ts src/__tests__/unit/usePageManagement.test.ts src/__tests__/unit/pdfTemporaryStorageBoundary.test.ts src/__tests__/unit/pdfTemporaryStorage.test.ts --testTimeout=30000 --exclude "**/.claude/**"` passed: 179 tests
- `npx vitest run src/__tests__/components/ThumbnailWindow.test.tsx src/__tests__/unit/useThumbnailPanel.test.ts src/__tests__/unit/useThumbnailWindow.test.ts --hookTimeout=30000 --testTimeout=30000 --exclude "**/.claude/**"` passed: 48 tests
- `npx vitest run src/__tests__/unit/pdfTextExtractor.test.ts src/__tests__/unit/usePageNavigation.test.ts src/__tests__/unit/useOcrEngine.test.ts src/__tests__/integration/ocrEngineFlow.test.ts --testTimeout=30000 --exclude "**/.claude/**"` passed: 80 tests
- `npx vitest run src/__tests__/unit/appBatchJobWiring.test.ts src/__tests__/unit/useKeyboardShortcuts.test.tsx src/__tests__/unit/usePdfViewerState.test.ts src/__tests__/unit/usePdfRendering.test.ts --testTimeout=30000 --exclude "**/.claude/**"` passed: 41 tests
- `npx vitest run src/__tests__/unit/pdfSaver.test.ts src/__tests__/unit/pdfSaver.acrobat7compat.test.ts --testTimeout=30000 --exclude "**/.claude/**"` passed: 52 passed / 1 skipped
- `npx vitest run src/__tests__/integration/pdfSaverAcrobatWordBreak.test.ts src/__tests__/integration/pdfSaverRotateOcr.test.ts --testTimeout=30000 --exclude "**/.claude/**"` passed: 8 tests
- `npm run test:critical` passed: 90 passed / 1 skipped, then 116 passed
- `npm run build` passed
- `npm run test:e2e:ci` passed: 74 passed / 1 skipped
- `git diff --check` passed (CRLF warnings only)
