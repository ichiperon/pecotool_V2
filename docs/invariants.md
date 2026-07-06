# PecoTool v2 — 不変条件目録

## 目的と使い方

PCT-001〜097 のパッチで得た設計上の制約を一か所に集めたものです。変更を加える前にここを照合してください。

**更新ルール**: 不変条件に触れる修正をする際は、同一 PR でこのファイルも更新すること。

---

## 1. 保存の正しさ

**S-01 — スナップショット一貫性**
`buildPdfDocument` / `pdf.worker.ts` に渡す `document.pages` と `pageOrder` は同一スナップショットから取ること（PCT-037）。await 後に一方だけ差し替えると、別物理ページに dirty を適用する。

**S-02 — メモリ優先マージ**
LRU 退避 → 再訪 → 編集の順でページを触ると IDB には古い値が残る。保存マージは `!mergedPages.has(idx)` 時のみ IDB を採用する（PCT-068）。メモリ優先を崩すと編集前の内容が PDF に書かれ、dirty も解除されてサイレントに失敗する。

**S-03 — 保存後 pageOrder 正規化**
pageOrder が非恒等の保存完了後、store の pageOrder を identity に戻すこと（PCT-034）。戻さないと 2 回目の保存で再度並べ替え・削除が適用される。

**S-04 — 非恒等 pageOrder は clean short-circuit をバイパス**
dirty ページがなくても `isDefaultOrder` が false なら元 PDF bytes をそのまま返してはいけない（PCT-035）。構造変更が落ちる。

**S-05 — clearTemporaryChanges はスナップショット範囲のみ**
保存完了後の IDB クリアは `clearTemporaryChangesForPages`（保存で回収したページのみ）を使う（PCT-070）。無差別全削除はスナップショット外の編集を消す。

**S-06 — clearIdbDirty 直前に pending IDB 書込を待つ**
`clearIdbDirty` の直前に `waitIdbSavesBeforeClear` を呼ぶ（PCT-050）。待たないと書込完了前にエントリが消える。

**S-07 — atomic rename**
`replace_pdf_file` は単一 `std::fs::rename`（= `MoveFileExW(REPLACE_EXISTING)`）で完結させる（PCT-077）。2 段 rename（target → backup → temp → target）は中断時に target が消える窓を作る。Windows の `std::fs::rename` は既存ファイルを上書きできることを cargo テストで実証済み。

**S-08 — rename 直前 fsync**
rename の直前に `sync_file_to_disk` を 1 回呼ぶ（PCT-078）。呼ばないと rename 直後の電源断で不完全な内容が target に昇格する。毎チャンク fsync は性能劣化のため不採用。

**S-09 — IDB キー rename は廃止（pageId 不変による）**
PCT-104 A-lite（段階3）で `renameTemporaryPageKeys` を全廃した。pageId は初期ソースインデックス固定（`"src:" + initialSourceIndex`）のため、ページ移動・削除・undo/redo のいずれでも IDB キーは変化しない。PCT-069 で実装した undo/redo の逆順 rename も不要となり削除済み。reorder_pages の undo/redo は IDB 操作なし、delete_pages の undo/redo は `deletePageIds`（pageId 形式）の delete のみで完結する。

**S-10 — 保存中の並走防止**
`handleOpen` の `loadPDF` await 後に `isSavingRef` を再チェックする（PCT-074）。保存中の読込開始は中断してトーストを出す。diff プレビューと SaveAs の await 後も同様（PCT-075）。

**S-11 — バッチ中の OCR ゼロプロンプト抑止**
バッチジョブ経路では `suppressOcrZeroPrompt` を指定する（PCT-076）。指定しないと OCR ゼロ検出プロンプトがバッチ中に発火し、「はい」で `importTextLayerAllPages` がバッチ OCR と同一ページへ並行書込する。

**S-12 — PecoTool メタを持つ PDF はテキスト層の自動取り込みをスキップ**
`checkAndPromptOcrZero` はメタ有無を冒頭で確認し、メタあり PDF では取り込みもプロンプトも行わない（PCT-094）。違反すると開く→保存のたびに pdfjs fallback の bbox で上書きされ bbox が保存毎に潰れる。メタ取得時は `loadPage` にメタを渡しメタ経路で解決させる。

**S-13 — meta ロードは不正エントリのみ drop する**
`sanitizeBBoxMetaRecord` は不正エントリをエントリ単位で drop し有効分を必ず保持する（PCT-049）。all-or-nothing に戻すと1件の破損で文書全体の meta が null になり全ページの OCR データが再オープンで消失する。

**S-14 — 保存オーケストレーションは単一実装（PCT-100）**
保存の全ロジックは `buildPdfDocumentCore`（`pdfSaverCore.ts`）に集約する。`pdfSaver.ts`（main 殻）と `pdf.worker.ts`（worker 殻）はアダプタ（bytes 解決・pages 正規化・timeout 指定・コールバック変換）のみを担い、保存ロジックを殻側に再実装してはいけない。殻にロジックを書くと PCT-052/053/096 と同類の二重実装漏れが再発する。

---

## 2. 座標・回転

**C-01 — viewport-space px の一貫性**
bbox は viewport-space px（rotated screen, y-down）で統一する。保存・読込・OCR 表示の全経路が同じ座標系を使うことで恒等変換が成立する（R-05, PCT-052/053）。pdfjs textItems 経由の idx マッチングは件数食い違いでテキストが 1 ブロックズレる既知バグがあるため、保存メタ読込時に採用しない（`pdfTextExtractor.ts` コメント）。

**C-02 — 回転ページの cm 計算**
bbox → PDF 座標変換は viewport 寸法（`vw/vh`）と `getRotationCm` を使う（issue #71）。rotation=0 仮定の `translate(bbox.x, pageH - bbox.y)` はページ外に飛ぶ。

**C-03 — pdfSaver と pdf.worker.ts の対称性**
【PCT-100 で解消】保存オーケストレーションは `buildPdfDocumentCore`（`pdfSaverCore.ts`）に単一化。`pdfSaver.ts`（main 殻）と `pdf.worker.ts`（worker 殻）は薄いアダプタのみで、ロジックの二重実装は構造的に発生不能。PCT-052/053/096 のような「片方だけ実装漏れ」は起きない。`saverWorkerEquivalence.test.ts` は equivalence の回帰ガードとして引き続き維持する。

**C-04 — writing mode は PDF user space で判定**
`|uy| > |ux|` は PDF 座標系（フォント行列）で判定する（issue #39, `pdfTextExtractor.ts`）。viewport 変換後のスクリーン座標で判定すると /Rotate 90/270 ページで横書きが縦書きと誤判定される。

**C-05 — descent 比の上限 0.12**
`getFontDescentRatio` の戻り値は `DESCENT_RATIO_CAP = 0.12` で打ち切る（PCT-092）。Meiryo の hhea 設計値（行間込み）は約 0.293 で、スキャン原稿の実ベースラインより大きく Acrobat 選択ハイライトが左上へずれる。

**C-06 — bboxMeta は await して解決してから loadPage を呼ぶ**
`usePageNavigation` で `bboxMetaRef` は `loadPage` の前に確実に resolve する（issue #99 主因対策, `usePageNavigation.ts` コメント）。fire-and-forget で後埋めすると bboxMeta=null のまま pdfjs fallback で bbox を再計算し、IDB に誤った bbox が固着する。

**C-07 — OCR 位置補正の既定は 0/0**
`ocrSettingsStore` の `pdfTextOffsetRightMm` / `pdfTextOffsetDownMm` の既定は 0/0（PCT-117）。補正は pdf-lib の出力座標を素で平行移動する処理であり、ビューア固有の癖を補正するものではない（どのビューアでも一律にずれる）。非 0 を既定にすると「ツール表示 BB == 保存テキスト層」（最低保証 #5）を生 PDF 座標の時点で破る。非 0 はユーザーが明示設定したときのみ。旧既定（右 4mm・下 2mm）を持つ既存ユーザーは persist `version: 1` の `migrate` で 0/0 にリセットする（`ocrSettingsStore.ts`）。補正適用ロジック（`pdfSaverCore.ts` の `textLayerOffsetPt`）自体は変更しない。

---

## 3. 状態同期・競合

**ST-01 — source/display pageIndex の分離と pageId による安定参照**
`currentPageIndex`（display）、`pageOrder`、元 pdfDoc ページインデックス（source）は三者を混同しない（PCT-001）。IDB 一時変更の読み書き、OCR 対象、保存対象のそれぞれで正しい index を使う。PCT-104 A-lite 以降、IDB `temporary_changes` のキーは displayIndex でなく **pageId**（`"src:" + initialSourceIndex`）を使う。displayIndex → pageId の変換は `resolvePageId(pageOrder, displayIndex)`、pageId → 現在の displayIndex の変換は `resolveDisplayIndex(pageOrder, pageId)` を経由する。

**ST-02 — Thumbnail requestId ガード**
サムネイル Worker 応答は requestId と file epoch の両方でガードする（PCT-012〜016）。古い応答が新ファイルや pageOrder 変更後の pending を解決することを防ぐ。

**ST-03 — documentEpoch の伝播**
`documentEpoch` は全 Thumbnail 経路（メインパネル・ThumbnailWindow・useThumbnailWindow）が購読する（PCT-017/018）。同一 filePath の再読込を検出するために必要。

**ST-04 — IDB 操作はシリアル化**
同一 tick のページ削除・移動連打は hook-local operation queue でシリアル化する（PCT-031）。並走すると rename/delete が競合する。

**ST-05 — clearOcrAllPages は pending を待つ**
空 OCR の IDB 書込は既存 pending save が完了してから行う（PCT-028）。待たないと古い OCR が後勝ちで復活する。

**ST-06 — ロールバック時の generation guard**
LRU 保存失敗ロールバックは generation counter で照合する（PCT-030）。古いロールバックが新しい clearOcrAllPages を上書きして旧 OCR を復活させることを防ぐ。

**ST-07 — IME 変換中の flush スキップ**
`compositionstart/end` で `data-composing` 属性を立て、Ctrl+S による `flushActiveOcrCardText` は composing 中はスキップする（PCT-051）。スキップしないと未確定文字がストアにコミットされる。blur 経路（PCT-067）は WebView2 実機での compositionend 発火順確認待ちで別途対応が必要。

**ST-08 — pageId は不変（PCT-104 A-lite）**
pageId は `"src:" + initialSourceIndex`（ファイルを開いた時点のソースインデックス）で確定し、以後の move/delete/rotate/undo/redo を通じて変化しない。IDB キー `filePath:pageId` はページの物理的な移動・削除操作で変化しない。

単一保存サイクル内では pageId は不変。保存完了時に normalizePageOrderAfterSave 連動で remap を実行し、IDB 残存エントリのキーを normalize 後の pageOrder に追従させる。IDB を読む側（LRU 復元・replaceText all スコープ等）は常に現在の pageOrder で resolveDisplayIndex して displayIndex に変換する（IDB キーは pageId のまま変化しないが、displayIndex は pageOrder 変化で変わる）。

保存中はライブ pageOrder を読まず、保存スナップショット時点の savePageOrder を使うこと（M1）。

同じ規律は保存処理に限らない。undo/redo の各 action 分岐、replaceText/replaceTextBatch の
IDB read await（`getAllTemporaryPageData`）等、非同期処理を挟んで最後に `schedulePendingIdbWrite`
系のヘルパを呼ぶすべての箇所で、呼び出し元は処理開始時点（関数 entry または action 適用時点）の
pageOrder を 1 度キャプチャし、以降の await をまたいでも同じ値を使い続けること。途中で
`get().pageOrder`（live）を再取得すると、await 中に割り込んだ movePage 等で `resolvePageId` の
解決結果がずれ、書き込み先 pageId が別ページのものと入れ替わる（PCT-162: undo/redo の rotate_pages
分岐が schedulePendingIdbWrite 自体を呼んでいなかった欠落／PCT-163: replaceText/replaceTextBatch が
entries 解決に使った pageOrder と書き込み時に渡す pageOrder が異なっていた不一致）。

LRU 退避（in-memory に無い）ページへの部分更新を書く場合、`saveTemporaryPageDataBatch` は
`store.put()` でレコード全体を置換する（マージではない）。rotation 等の一部フィールドだけを
書こうとすると既存の textBlocks 等が消える。退避ページ向けの部分更新は既存 IDB レコードを
読み戻してから対象フィールドだけ上書きし、フルレコードとして書き戻すこと
（`scheduleClearOcrAllPagesIdbWrite`・`scheduleRotateUndoRedoIdbWrite` の実装を参照）。
読み戻した既存レコードに textBlocks が無い（＝巻き戻す実体が無い）場合は、
`{pageIndex, rotation, isDirty}` のような骨格レコードを新規に書き込んではいけない。
PageData 型不変条件を破り、保存経路でテキスト層 strip に繋がりうる（forward の rotatePages が
`if (partial && partial.textBlocks)` で同じケースを除外しているのと対称にすること）。

read-modify-write 型（`waitForPendingIdbSaves()` 等で待機したあと `getAllTemporaryPageData` で
読み戻してから書く）の遅延ヘルパは、待機後と IDB read 後の 2 箇所で documentEpoch を再確認する
二重ガードを必須とする（PCT-181 / #412 先例: `scheduleClearOcrAllPagesIdbWrite`）。await を跨ぐ
たびにファイル切替が割り込める窓があるため、1 箇所のガードだけでは 2 await 目の窓を防げない。

pageId を変える操作（例: ページの新規追加で別ソースインデックスを割り当てる）を設計する場合は、IDB キー衝突の可能性を精査すること。

**ST-09 — IDB 旧キー（filePath:N）は移行期間中フォールバック読込する**
PCT-104 A-lite 以前に保存されたデータには `filePath:pageIndex`（数値インデックス）形式のキーが残存する可能性がある。`getTemporaryPageData` / `getAllTemporaryPageData` は新キー（`filePath:src:N`）を優先しつつ旧キー（`filePath:N`）もフォールバックとして読み込む。`deleteTemporaryPageKeys` は両キーを同時に削除する。移行完了後（十分なバージョンが普及した段階）にフォールバックロジックを除去できる。

---

## 4. Acrobat 7 互換

**A-01 — issue #1 スキャン（BT 外テキスト演算子）は fontBytes 有無に依存しない**
`sweepNonDirtyPage` の `issue #1` 損傷検知は `isPecoToolFontKey` でガードしてはいけない（PCT-059 棄却コメント, `pdfSaver.ts:578〜` コメント）。bloat 検知（フォント数しきい値）とは別の処理で、ガードすると非 PecoTool フォントページの Acrobat 7 損傷がサイレントに素通りする。

**A-02 — useObjectStreams:false**
既定プリセットでは `useObjectStreams: false` を維持する。`'compressed'` プリセット選択時のみ `true`（Acrobat 7 互換を意図的に放棄する明示モード・issue #206）。`pdfSaver.ts:606-610` / `pdf.worker.ts:439-442`。

**A-03 — PDF バージョン保持**
入力 PDF の PDF バージョン（`%PDF-1.x` ヘッダ）は `extractPdfVersion/restorePdfVersion` で保存後に書き戻す。

**A-04 — テキストは BT...ET で囲む**
テキスト演算子は必ず BT...ET オブジェクト内に配置する（Acrobat 7 互換の基本要件）。

**A-05 — Acrobat dirty-flag 回避**
保存後に元 PDF の trailer /ID を `overwriteTrailerId` で書き戻す。pdf-lib の save() は /ID を再生成するため、書き戻さないと Acrobat が毎回 dirty 判定する。

**A-06 — short-circuit は孤児オブジェクトゼロを確認してから**
clean short-circuit（入力 bytes をそのまま返す）の前に `sweepUnreachableObjects` を呼ぶ（issue #96）。孤児が 1 件以上あれば通常パスで全書き換えして孤児を除去する。

**A-07 — 各 BB 末尾に invisible スペース（U+0020, renderMode 3）を描画する**
Acrobat の text extraction は BT...ET 境界を無視し heuristic で隣接 BB を連結するため（issue #100）。外すと Ctrl+A コピペで隣接 BB が連結される。saver / worker は `buildPdfDocumentCore` に単一化（PCT-100）。core 内の横書き / 縦書き / curve の3描画分岐すべてに invisible スペースが必要、は不変。

---

## 5. IME・入力

**I-01 — OCR ページ範囲は `window.prompt()` を使っている**
`App.tsx` の OCR ページ範囲入力（`window.prompt` 呼び出し）は現時点で `window.prompt()`（PCT-061 バックログ）。日本語 IME の変換確定 Enter が OK として発火する疑いがある。実機で問題を再現確認してから置換を設計する。

**I-02 — Ctrl+0 は `e.key === '0'` だけでは不十分**
`e.key` 単独では取りこぼすため `e.code`（`'Digit0'`/`'Numpad0'`）も併用する（PCT-008、`useKeyboardShortcuts.ts:58`）。

---

## 6. Tauri 境界

**T-01 — Meiryo フォントは IPC でしか取得できない**
Worker 内での `fetch()` は Tauri のファイルシステムにアクセスできない。フォントバイト列は main thread 側で IPC（`readFile`）して Worker に渡す（PCT-060 棄却理由）。この構造上、保存のたびに ~3MB のコピーが 1 回発生するのは不可避。

**T-02 — capability は最小権限で維持**
実際に使用していない capability（`fs:allow-mkdir` など）は削除する（PCT-040 / RC Hardening）。JS 側の実装変更にテストの前提が追従せず空振り失敗した（PCT-040 の実態）。最小権限の維持と、実装変更時のテスト前提の同時更新が必要。カスタム Rust コマンドは fs scope が非適用であることを明記しておく。

**T-03 — updater capability は明示的に宣言が必要**
自動アップデートを機能させるには `updater` capability を明示宣言する（PCT-093）。欠如するとアップデートが無音で失敗する。

**T-04 — render_scale=0 ガード**
`do_windows_ocr` の `render_scale` は `is_finite() && > 0` をチェックする（PCT-079）。0 で呼ぶと 0 除算 → Infinity → serde が null 化する。

**T-05 — pdfLoader は進行中ロードを中断できる状態を保つ**
`getSharedPdfProxy` の `loadingTask` を保持し `destroySharedPdfProxy` で `task.destroy()` を呼べるようにする（PCT-072）。保持しないとファイル連続切替で in-flight ロードがメモリを占有し続ける。

---

## 7. 棄却済み案の目録

再提案を防ぐための記録です。「一見良さそうだが棄却された案」と棄却理由を示します。

---

### R-01 — sweep への `isPecoToolFontKey` ガード追加（PCT-059 棄却）

**案**: 未編集ページの sweep で `isPecoToolFontKey` が一致しないフォントをガードしてスキップすれば高速化できる。

**棄却理由**: issue #1 スキャン（`hasTextOperatorsOutsideTextObjects`）は bloat 検知（フォント累積数しきい値）とは独立した処理で、fontBytes の有無に依存しない設計になっている（`pdfSaver.ts:578〜` コメント, `sweepNonDirtyPage` JSDoc）。ガードすると非 PecoTool フォントページの Acrobat 7 損傷検知がサイレントに素通りする。性能改善は `sweepNonDirtyPage`（PCT-059 で実装）のように decode 結果の共有・1 パス化という設計変更で行う。

---

### R-02 — `forIncrementalUpdate` による増分更新（acrobat7compat.test.ts:221 の `it.skip`、pdfSaver.ts:140）

**案**: `PDFDocument.load(bytes, { updateMetadata: false })` + `forIncrementalUpdate` + `commit()` で増分更新にすれば Acrobat dirty-flag を根本解決できる。

**棄却理由**: fontkit の `embedFont({ subset: true })` と組み合わせると、glyf table の subset が OTS 検証をパスしない状態（Acrobat でも「フォントを抽出できません」）になる。ベンチ実測では `pdfDoc.save()` 全書き換えと `commit()` 増分は 91ms vs 126ms でほぼ同速。安全側の全書き換えを採用。`@cantoo/pdf-lib` 側で修正されるまで `it.skip`。

---

### R-03 — Worker 内フォント fetch / url 経路（PCT-060 棄却）

**案**: Worker シングルトン化 + フォントを Worker 内 `fetch()` で取得、または PDF bytes の url 経路を優先すれば保存のたびのコピーコストが減る。

**棄却理由**（ぼたん設計調査）:
1. Meiryo フォントは Tauri IPC でしか取得できず Worker 内 `fetch()` は不可。
2. フォントキャッシュを main に保持する限り、コピー 1 回は構造的に不可避。
3. url 経路は TOCTOU 窓（保存ベースバイト列の同一性）と連続保存のディスク再読込退行を生む。

利益（数十 ms/保存）がリスク（保存の正しさ）に見合わない。再挑戦条件: 200MB+ PDF での OOM 実測報告。

---

### R-04 — `heightAtSize` ベースの descentRatio（#99 が導入した方式を後に PCT-092 で棄却）

**案**: `font.heightAtSize(size, {descender:false})` で descent を動的計算すれば固定係数より正確な baseline になる。

**棄却理由**: `pdf-lib` のこの API は `unitsPerEm != 1000` のフォントで未スケールの descent を減算するバグを持つ。Meiryo / IPAmjMincho（ともに unitsPerEm=2048）では descentRatio が約 2 倍に膨張し、OCR テキスト層の baseline が bbox 上端方向へずれる（`getFontDescentRatio` JSDoc）。現在は fontkit の生メトリクス（`embedder.font.ascent/descent`）から直接算出し、さらに 0.12 で打ち切る（PCT-092）。

---

### R-05 — 2 段 rename によるクラッシュ対策（PCT-077 棄却）

**案**: target を backup に退避してから temp を target に rename する 2 段方式はクラッシュ時に元データを保全できる。

**棄却理由**: 2 段 rename は「target → backup」と「temp → target」の間にクラッシュすると target ファイル名が消失する窓を作る（HUNT-R1）。`lib.rs` の「Windows は rename が既存上書き不可」コメントは誤りで、`std::fs::rename` = `MoveFileExW(REPLACE_EXISTING)` で上書き可能なことを cargo テストで実測確認。単一 atomic rename に置換（PCT-077）。

---

### R-06 — `clearTemporaryChanges` で当該ファイルの一時退避を全削除（PCT-070 棄却）

**案**: 保存完了後、当該 filePath の一時退避を全件削除すればシンプル。

**棄却理由**: スナップショット外（保存中に発生した新規編集や LRU 退避）も削除する理論窓がある（PCT-070）。`clearTemporaryChangesForPages`（保存で回収したページのみ削除）に置換。

---

## 8. 自動テストの限界（実機でしか検証できない領域）

以下は自動テストでは検証できず、実機手動確認が出荷判定の前提となる。

- **Acrobat 7 でのテキスト層位置**: テキスト演算子の位置ズレは実機 Acrobat 7.0 での目視確認が必要（PCT-004, PCT-045）。pdfSaverDescentRatio テストは論理検証のみ。
- **実 IPC コマンド + Windows OCR**: Playwright は Tauri API を全モック。実 IPC コマンド・OS OCR を通しで叩く自動テストは存在しない（PCT-045）。単一ページ OCR の `pageData.width/height` 未ロードによる失敗（PCT-046）も手動テストで発覚。
- **日本語 IME 動作**: MS-IME での変換中 Ctrl+S（PCT-051）、blur 時の compositionend 発火順（PCT-067）は WebView2 実機でしか確認できない。`data-composing` ガードの有効性も実機目視。
- **Tauri capability 整合**: JS 側の実装変更で capability の要否が変わる。`tauriCapabilityIntegrity` テストは JS 側 mkdir 廃止前の前提で組まれており、実装変更後は条件付き skip になった（PCT-040）。capability と実書込先の整合は静的解析の外側。
- **大型 PDF の性能・メモリ**: 1000 ページ級 no-op 保存の所要時間（PCT-059 の decode 共有による改善効果）、100MB 級 PDF の連続開閉でのメモリ単調増加（PCT-073）はタスクマネージャ監視が必要。
- **保存中クラッシュ復旧**: atomic rename 後の電源断で元ファイルが無傷であること（PCT-077/078）は実機クラッシュ注入でしか確認できない。cargo テストは rename の上書き可否のみ検証。
- **cross-volume rename（SaveAs）**: 別ドライブ / ネットワークドライブへの SaveAs は `std::fs::rename` が失敗する。rename が失敗した場合の挙動（target 無傷・temp 残存・エラー文言）の確認が必要（cross-volume フォールバックは未実装）。
- **自動バックアップのタイミング**: 6 分超アイドル後のトースト表示（PCT-055）とバックアップ書込中のウィンドウ閉じ抑止は、タイマー実時間を使う実機でしか確認できない。

---

*最終更新: 2026-06-11 / PCT-104 A-lite 段階4 時点*
