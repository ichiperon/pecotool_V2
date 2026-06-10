# Review Issues 2026-06-10

v2.0.14 RC に対する総合レビュー（ユーザー指定5観点）の結果と修正記録。

レビュー観点と判定:

| 観点 | 優先度 | 結果 |
| --- | --- | --- |
| R-01: 1000ページPDF読込性能 | P1 | 構造は健全（dirty-onlyフィルタ/Transferable転送/二層LRU実装済み）。サムネイルWorker起動タイミングのみ修正（PCT-054） |
| R-02: OCR編集→保存の正確性（文字飛び・ゴミ混入） | P0 | 確実なデータ破損経路なし。条件付き競合2件を修正（PCT-050/051） |
| R-03: 保存速度 | P1 | Worker分離/チャンクIPC/short-circuit実装済み。未編集ページ全件inflateは設計検討が必要なためバックログ（PCT-059/060） |
| R-04: UX | P2 | P1級3件＋P2級4件を修正（PCT-055〜058, R04D-1/2/3）。残りはバックログ（PCT-066） |
| R-05: OCR位置の保存往復精度 | P0 | 座標系は viewport-space px で一貫し恒等変換を確認。Worker経路の実装齟齬2件を修正（PCT-052/053） |

**P0（確実なデータ破損・位置ズレ）は静的レビューの範囲で 0 件。** ただし「静的解析の範囲で」であり、実機手動チェックリスト（末尾）の消化が出荷判定の前提。

## Open

| ID | Priority | Issue | Owner | Status |
| --- | --- | --- | --- | --- |

## Closed（今回修正分）

| ID | Priority | Issue | Owner | Closed By |
| --- | --- | --- | --- | --- |
| PCT-050 | P1 | 保存完了処理の `clearTemporaryChanges` が `savePDF` 実行中に発生した新規LRU退避のIDB書込を待たず、書込完了前にエントリが消えうる | マリン発見 / ぺこら / ノエル | `clearIdbDirty` 直前に `waitIdbSavesBeforeClear`（再 `waitForPendingIdbSaves`）を追加。saveDuringEditRace に順序検証テスト追加。9 passed |
| PCT-051 | P1 | IME変換中の Ctrl+S で `flushActiveOcrCardText` が未確定文字を含む `textContent` を store にコミットしうる | マリン発見 / ぺこら / ノエル | compositionstart/end で `data-composing` 属性を設定し、flush 側で検知してスキップ（直前の確定済み store 値を保存に使用）。ocrEditFlush に3テスト追加。14 passed |
| PCT-052 | P1 | `pdf.worker.ts` の bboxMeta 書込で `confidence` 欠落（PCT-047 で永続化したのに Worker 経路で消える。pdfSaver.ts との二重実装齟齬） | スバル発見 / シオン / ノエル | pdfSaver.ts と同一の条件付き書込を追加。全フィールド照合で他の過不足なしを確認。curveBBoxMetaRoundtrip に roundtrip テスト2件追加。36 passed |
| PCT-053 | P1 | `pdf.worker.ts` の `page.getRotation().angle` に optional chaining がなく（pdfSaver.ts は対応済み）、エッジケースで例外→当該ページのOCR描画スキップの可能性 | スバル発見 / シオン / ノエル | `page.getRotation?.().angle ?? 0` に統一 |
| PCT-054 | P1 | サムネイルWorker起動の `requestIdleCallback` timeout 1500ms が重量PDFの初回render実測（~1.5s）と同値で、render中に強制起動して帯域競合しうる | ねね発見 / シオン / ノエル | timeout 3000 へ延長（idle なら従来どおり即起動、通常PDFの挙動不変） |
| PCT-055 | P1 | 自動バックアップの完了がユーザーに見えない＋バックアップ書込中にウィンドウを閉じられる（破損リスク）。※通知と close guard は片方だけ直すと悪化するためセット実装（らでん指摘） | ころね発見 / フブキ / ノエル | 完了トースト「自動保存しました（HH:MM）」+ `isBackingUpRef` を `useTauriCloseGuard` に連動。実装初版に「コールバック参照不安定によるバックアップタイマー毎レンダーリセット」の退行があり（えーちゃん diff 検証で検出）、ref パターンで修正・回帰テスト追加。35 passed |
| PCT-056 | P2 | バッチ実行中にダイアログ外クリックでダイアログが閉じ、進捗が見えなくなる | ころね発見 / フブキ / ノエル | `!isRunning` ガード追加。テスト2件新規 |
| PCT-057 | P2 | バックアップ復元ダイアログのタイトル「未保存の内容があります」が「今の作業の保存し忘れ警告」と誤読される | ころね発見 / フブキ / ノエル | 「前回の作業バックアップが見つかりました」へ変更 |
| PCT-058 | P2 | OCR未実行ページの空状態「OCRテキストなし」に次アクション導線がない | かなた+ころね発見 / フブキ / ノエル | 「このページにOCRテキストがありません」+「リボンの「OCR実行」でテキストを読み取れます」の2行構成へ |
| R04D-1 | P1 | 編集中（フォーカス中・未コミット）のOCRカードと確定済みカードが視覚的に区別できない | かなた発見 / ぺこら / ノエル | `.ocr-card:focus-within` でアンバー枠+影を追加（selected の青枠が優先される詳細度序列をコメントで明示） |
| R04D-2 | P1 | 書込失敗トーストに OS エラー文字列が生出し（"os error 32" 等が業務オペレーターに表示される） | かなた発見 / ぺこら / ノエル | 「他のアプリでこの PDF が開かれている可能性があります。閉じてから再度保存してください。」へ。元 msg は console.warn でログ保全 |
| R04D-3 | P1 | 読込失敗トースト「元 PDF の読み込みに失敗しました。」に次アクション案内がない | かなた発見 / ぺこら / ノエル | 「元のPDFファイルが移動または削除された可能性があります。ファイルを再度開き直してください。」へ |

## 検証結果

- `npx tsc --noEmit` passed: 0 errors
- `npm run test:critical` passed: PDF acceptance 90 passed / 1 skipped, state acceptance 117 passed
- `npm test`（広域 unit/components/integration）passed: 1952 passed / 3 skipped / 1 todo, **0 failed**
- `npm run test:e2e:ci` passed: **74 passed / 1 skipped / 0 failed**（初回走行で [E-ER-01] が 1 件失敗 → 原因は R04D-2/3 の文言変更への期待正規表現の追従漏れ。旧文言の「失敗」「開けません」が新文言に含まれずマッチ不能になっていた。errorHandling.spec.ts の期待値に「開かれている」「開き直して」を追加して追従。プロダクション側は無変更。spec 単体 → フル再走で全件green）
- 文言影響の事前 Grep は完全文言一致で行ったため、E2E 期待値の**部分語正規表現**は検出漏れした（教訓: 文言変更時は正規表現アサートも対象に grep する）
- `package-lock.json` が package.json と不整合だった点を修復（version 1.6.9 のまま・`@tauri-apps/plugin-updater` が lock 未登録。CI の `npm ci` はこの状態で失敗するため要コミット）
- Rust (src-tauri) 変更なしのため cargo テストは対象外

## Backlog（RC 後・優先度順）

| ID | Priority | Issue | 備考 |
| --- | --- | --- | --- |
| PCT-059 | P2 | 保存時に未編集ページ全件へ `pageHasTextOperatorDamage`（pako.inflate）+ `stripEmptyQBlocksOnPage` が走り、1000ページ級 no-op 保存で数百ms〜数秒（コード内コメント自認）。**単純な isPecoToolFontKey ガード追加は不可**: issue #1 スキャンは「bloat detection と異なり fontBytes 有無に依存しない」設計（pdfSaver.ts:586 コメント）で、ガードすると非PecoToolフォントページの Acrobat 7 損傷検知がサイレント素通りする。同ループ内で damage チェックと q-Q strip が各々 decode するため、decode 結果の共有・1パス化として設計が必要 | るしあ発見 / らでん+コード実査でガード案を棄却 |
| PCT-060 | P2 | 保存Worker毎スポーン + フォントバイト列（Meiryo ~3MB + fallback）と PDF bytes の `slice()` フルコピーを保存のたびに実施（既存 TODO #184）。Workerシングルトン化 or url 経路優先化 | るしあ発見。100MB級PDFでコピーコスト顕著 |
| PCT-061 | P2 | OCRページ範囲入力が `window.prompt()`（App.tsx:836）。日本語IMEの変換確定EnterがOKとして発火する疑い（※要実機確認）＋デザイン不整合。専用入力モーダルへの置換は実機で問題を再現確認してから設計する（らでん判断） | ころね+かなた発見 |
| PCT-062 | P2 | `shouldUseSavedMeta` のフラグメント過多閾値（textItems*2 or +25）超過で保存済みメタが無視され pdfjs fallback の bbox になり、保存→再読込で BB 位置が目視で変わって見えるケース | スバル発見。閾値の意図（外部OCR PDF対策）があるため変更は慎重に |
| PCT-063 | P2 | 初回ページの bboxMeta ロードで `getSharedPdfProxy` → `readFile`（ファイル全読み）が直列 await。100MB級で初期表示が遅延 | ねね発見。並列化はメモリピーク増（PDF+bytes同時保持）の評価が必要 |
| PCT-064 | P3 | IDB: `pruneCachedPages`（800件カーソルスキャン）が `setCachedPage` の await チェーンをブロック / `renameTemporaryPageKeys` の `entries.find` が O(N²) | ねね発見。fire-and-forget 化 / Map 化で解消可 |
| PCT-065 | P3 | `sanitizeTextForPdfCopy` で除去した制御文字が bboxMeta 側にも反映され、次回ロードで「入力した文字が消えた」と感じうる（通常編集では発生しない。skippedChars トーストで通知済み） | マリン発見。実運用での発生条件を要調査 |
| PCT-066 | P3 | UX改善残: 置換トーストの「ブロック」用語 / 保存開始トーストとオーバーレイの重複 / DiffPreview 件数多時のボタン可視性 / input 中 Ctrl+S / SaveDialog インライン色指定 / ヘルプの「BB」用語説明 / 空状態の操作経路具体化 / 閉じる確認にダーティ件数 / DnD 起動閾値 8px | かなた+ころね発見の P2/P3 群 |
| PCT-067 | P2 | blur 経路の IME 未確定混入: 変換中に別カードをクリックすると `handleBlur` が compositionend を待たず textContent をコミット。blur と compositionend の発火順は環境依存。Ctrl+S 経路は PCT-051 で対応済み | マリン+ころね発見。WebView2 実機での発火順確認が先 |

## 実機手動チェックリスト（自動化不可・出荷判定の前提）

リリース最低保証ライン: ①保存の正しさ（絶対） ②表示の正しさ（ホワイトアウト無/BB位置）

1. **IME（PCT-051 検証）**: 日本語変換中に Ctrl+S → 未確定文字が保存されない・確定済みテキストは保存される（MS-IME / Windows 11）
2. **IME（PCT-067 確認）**: 変換中に別カードへクリック（blur）→ 未確定文字がコミットされないか挙動確認
3. **1000ページ級PDF**: 読込→初期表示時間 / スクロール中のUI固まり / サムネイル順次生成 / メモリ安定（タスクマネージャ監視）
4. **保存速度**: 1000ページ・編集1ページの保存所要時間（保存ロックオーバーレイの3ステップ進捗で体感確認）
5. **Worker経路保存の confidence（PCT-052 検証）**: OCR実行→保存→再オープン→「要確認マーク」ハイライトが残存すること
6. **回転ページ**: 90/180/270°ページの OCR編集→保存→再読込で位置不変
7. **保存往復（保証ライン）**: 編集→保存→閉じる→再読込で BB 位置が変わらない・テキスト欠損なし・ゴミ混入なし
8. **バックアップ（PCT-055 検証）**: 編集後アイドル6分強で「自動保存しました（HH:MM）」トースト表示 / バックアップ書込中のウィンドウ閉じが抑止される
9. **Acrobat 7 目視**: テキスト層位置の目視確認（既存残項目・継続）

## 今回見送った修正（理由付き）

- **R03-1 への単純ガード追加**: 上記 PCT-059 のとおり損傷検知を壊すため棄却。性能改善は decode 共有設計とセットで次パッチへ
- **window.prompt 置換**: 実機での IME 問題再現確認が先（PCT-061）
- **pdfSaver.ts / pdf.worker.ts の共通化リファクタ**: 二重実装齟齬（PCT-052/053）の根本原因だが、RC段階での保存経路リファクタはリスクが利益を上回るため次マイルストーンで検討

---

# Deep-Fix セッション（2026-06-10 同日・Fable 5 体制）

PR #302（RC修正13件）確定後、Fable 5 モデルのエージェント体制で (1) PCT-059 の設計実装 (2) 未調査領域（Rust/IPC・リソースリーク・操作交差）の不具合ハント (3) 発見分の修正、を実施。ブランチ `claude/fable5-deep-fix`。

## ハント結果サマリ

| 領域 | 担当 | 発見 | 特記 |
|---|---|---|---|
| Rust/IPC 境界 | いろは | P1×1（HUNT-R1）+ P2×5 | パストラバーサル/整数境界/プロト汚染/backup直パス/COM対称性/temp衝突は全て防御済みを確認 |
| メモリ/リソースリーク | あやめ | P2×2（M1/M2）+ P3×7 | revoke/close/terminate/リスナー29箇所/タイマーの cleanup は概ね健全を確認 |
| 競合・非同期交差 | まつり | **P1×3（C1/C2/C3）**+ P2×2 + P3×4 | 13種の操作交差で「問題なし」を確認した上での検出。C1 は通常業務フローで踏む保存巻き戻り |

## Closed（Deep-Fix 分）

| ID | Priority | Issue | Owner | Closed By |
| --- | --- | --- | --- | --- |
| PCT-068 | **P1** | 保存マージが IDB 優先（`{...existing, ...data}`）のため、「LRU退避→ページ再訪で復元（IDBエントリ残存）→編集（メモリのみ更新）→保存」で**古い IDB が新しい編集を上書きし、編集前の内容が PDF に書かれる**。resetDirty は現メモリ参照で照合するため dirty も解除され完全サイレント。51ページ超+全ページOCR+編集の通常業務フローで発生 | まつり発見 / えーちゃん裏取り / ぺこら / マリン | マージをメモリ優先（`!mergedPages.has(idx)` 時のみ IDB 採用）に反転。IDB 書込全経路（LRU退避/undo-redo write-through/clearOcrAllPages）で「メモリ在ページは常にメモリが最新か同値」を検証。ミューテーション実証付き回帰テスト追加 |
| PCT-069 | P1 | ページ移動/削除の IDB キー rename を undo/redo が巻き戻さず、移動→undo→保存で**別ページのテキストが混入した PDF が保存される** | まつり発見 / ぺこら / マリン | Action に renamedEntries を記録し undo=逆rename・redo=順rename を `scheduleStructuralUndoRedoIdbSync`（delete→rename→書込の直列+pendingIdbSaves トラッキング）で適用。ステートフル fake IDB の E2E 級テスト追加 |
| PCT-070 | P3→恒久化 | 保存後の `clearTemporaryChanges` が当該ファイルの一時退避を無差別全削除（スナップショット外の編集も消える理論窓） | まつり発見 / ぺこら / マリン | `clearTemporaryChangesForPages`（保存で回収したページのみ削除）を新設し保存完了処理を置換 |
| PCT-071 | P3 | `saveTemporaryPageDataBatch` の自前タイムアウトが clearTimeout されず10秒間の野良タイマーが編集ごとに滞留 | あやめ発見 / ぺこら | 既存 `waitForTransaction`（clearTimeout 済み）への置換。fake timers でタイマー残数0を検証 |
| PCT-072 | P2 | `pdfLoader` が getDocument の loadingTask を保持せず、**進行中ロードを中断できない**（ファイル連続切替で in-flight 滞留・ハング時は恒久リーク） | あやめ発見 / フブキ / マリン | loadingTask を共有 proxy に保持し `destroySharedPdfProxy` で即時 `task.destroy()`。unhandled rejection 全経路確認済み |
| PCT-073 | P2 | ファイルクローズ後もサムネ Worker（最大4体）が閉じた PDF の解析構造を**次のロードまで抱え続ける**（100MB級で数十MB/worker） | あやめ発見 / フブキ / マリン | Worker プロトコルに `CLOSE_PDF` を追加し、document null / file-closed で post。worker 側は `releaseCurrentPdf()` で destroy |
| PCT-074 | P1 | `handleOpen` の loadPDF await 後に isSavingRef 再チェックがなく、読込中の Ctrl+S（保存開始）と交差すると `clearTemporaryChanges(旧パス)` が保存の IDB 回収と競合し**旧ファイルが退避 dirty 欠落のまま上書き**されうる | まつり発見 / あくあ / マリン | loadPDF await 後の再チェック（保存中なら読込中止+トースト）+ 対称ガード（読込中の保存拒否）。「待つ」案は保存完了 Promise 機構が無くリスク過大のため「中断+案内」を採用（マリン裁定済み） |
| PCT-075 | P2 | 保存 diff プレビュー/SaveAs ダイアログの await 後に再チェックがなく**_executeSave が2本並走**しうる。resolver 無条件上書きでゾンビ Promise も発生 | まつり発見 / あくあ / マリン | await 後の isSavingRef 再チェック + `requestDiffPreview` ヘルパー（旧 resolver を false 解決してから差し替え） |
| PCT-076 | P2 | バッチジョブ中に OCR ゼロ検出プロンプトがすり抜けて発火し、「はい」で importTextLayerAllPages がバッチ OCR と同一ページへ並行書込 | まつり発見 / あくあ / マリン | `handleOpen` に `suppressOcrZeroPrompt` を追加しバッチ経路で指定。多重防御として `runOcrAllPages` 入口に実行中ガード追加 |
| PCT-059 | P1（性能） | 保存時に未編集ページ全件で content stream が**2回 inflate**される（damage 検査 + 空q-Q strip が各々 decode）。1000ページ no-op save で約2000回・数百ms〜数秒 | るしあ発見 / ぼたん設計 / シオン / マリン | `sweepNonDirtyPage` 新設（decode 共有1パス化・損傷ありは従来経路へ委譲）。**旧経路との differential 等価性テスト6本**（最終バイト列一致）+ decode 回数 spy（旧2回/新1回）で挙動不変を機械的に保証。issue#1 損傷検知の検出能力は不変 |
| PCT-077 | P1 | `replace_pdf_file` の2段階 rename（target→backup → temp→target）の間にクラッシュ/電源断が起きると **target ファイル名が消失**する窓。`lib.rs` の「Windows では rename が既存上書き不可」コメントは誤った前提だった（検証テストで実測確定: `std::fs::rename` = `MoveFileExW(REPLACE_EXISTING)`） | いろは発見 / シオン（検証ファースト） / マリン | 単一 atomic rename 化。クラッシュ窓と backup 残骸（HUNT-R2）を同時に解消。rename 失敗時は target 無傷・temp 残存（手動復旧情報をエラーに含む）。プラットフォーム回帰検知テストを恒久化 |
| PCT-078 | P2 | `write_chunk_at` が sync_all せず、rename 直後の電源断で不完全な内容が target に昇格しうる | いろは発見 / シオン | `sync_file_to_disk` を rename 直前に1回実行（毎チャンク fsync は性能劣化のため不採用） |
| PCT-079 | P2 | `do_windows_ocr` の render_scale=0 で 0除算→Infinity→serde が null 化（正規UIからは到達不可・防御的） | いろは発見 / シオン | 冒頭に `is_finite() && > 0` ガード追加 |

## 見送り（Deep-Fix 分・理由付き）

- **PCT-060（保存Worker毎スポーン+バイト列フルコピー / TODO #184）**: ぼたんの設計調査で「実装見送り」が結論。(1) Meiryo フォントが Tauri IPC でしか取得できず Worker 内 fetch 不可 (2) キャッシュを main に保持する限りコピー1回は構造的に不可避 (3) url 経路は TOCTOU 窓（保存ベースバイト列の同一性）と連続保存のディスク再読込退行を生む。利益（数十ms/保存）がリスク（保存の正しさ）に見合わない。TODO コメントに調査結論を追記済み。再挑戦条件: 200MB+ PDF での OOM 実測報告
- **HUNT-R3（保存中断時の .tmp 残留）**: 削除に fs scope 拡張 or 専用 Rust コマンドが必要で中規模。バックログへ（PCT-080 として下記）
- **HUNT-R4（capability scope と実書込先の不整合）**: カスタムコマンドは fs scope 非適用のため現状実害なし。ドキュメント整備対象

## バックログ追記（Deep-Fix 分）

| ID | Priority | Issue | 備考 |
| --- | --- | --- | --- |
| PCT-080 | P2 | 保存失敗（チャンク書込中断・rename 失敗）時の `*.pecotool-*.tmp` がユーザーのフォルダに累積する。掃除には元PDFディレクトリへの削除権限（fs scope 拡張 or Rust cleanup コマンド）が必要。PCT-077 で rename 失敗時の temp は意図的に残す設計（手動復旧用）にしたため、起動時 stale temp 検出が本筋 | いろは発見・マリン非ブロッキング指摘と同根 |
| PCT-081 | P3 | 復元直後の極小窓（復元 IDB 書込完了前の lazy loadPage）で「メモリ pristine / IDB 復元データ」となり、その状態が LRU 落ちまで持続しうる。保存出力は画面表示と一致（WYSIWYG）し復元データも IDB に残存するため実害なしと裁定済み。構造的に閉じるには `usePageNavigation` の loadPage 前に `waitForPendingIdbSaves()` 1行 | ぺこら発見・マリン裁定（許容・任意強化） |
| PCT-082 | P3 | 削除 undo で LRU 退避済みページの編集内容が戻らない（pre-existing。旧コードも forward delete で IDB エントリを消去）| マリン観察。PCT-069 の悪化ではない |
| PCT-083 | P3 | フォルダ OCR は `suppressOcrZeroPrompt` 非適用（入口ガードで並行書込は防止済み・プロンプト表示のみ残る）。バッチと挙動を揃える | マリン観察 |
| PCT-084 | P3 | リーク微小残: Tauri listen() のアンマウント競合（useThumbnailWindow/ThumbnailWindow/usePreviewWindow の3パターン・実害は dev/HMR 時のみ）/ ファイル切替中の createImageBitmap 完了が旧 bitmap を死蔵（LRU 上限内）/ パネルアンマウント直後のサムネ ObjectURL（最大1バッチ・数十KB）/ getCachedPageProxy の await 後再チェック | あやめ発見 P3 群 |
| PCT-085 | P3 | 競合微小残: 自動バックアップの await 中ページ操作で混在インデックス JSON（5分毎×数十ms窓）/ save→backup 方向のガード非対称 / バッチ実行中の X ボタン・Ctrl+O 素通り / 連続オープンキャンセルで recent から誤削除 | まつり発見 P3 群 |
| PCT-086 | P3 | `useOcrEngine` の `Array.from(bytes)`（PNG を number[] 化して IPC）がページあたり PNG の約8倍の一時ヒープを使う | あやめ補足（性能） |
| PCT-087 | P3 | TS 側 IPC エラーの silent drop（clear_backup の catch(()=>{})、check_pending_backups の warn のみ）。監査性向上の余地 | いろは補足 |

## 検証結果（Deep-Fix 分）

- `npx tsc --noEmit` passed: 0 errors
- `npm run test:critical` passed: 216（PDF 90+1skip / state 126）
- `npm test`（広域）passed: **2000 passed / 0 failed**（PR#302 時点 1952 → +48。全て今回の回帰テスト追加分）
- `cargo test` passed: **43**（既存32 + 改修4 + 新規7。rename 上書き可否の実測検証テスト含む）
- ミューテーション検証: PCT-068/069/070/071/074/075/076 で「修正を外すと狙ったテストだけが fail する」ことを実装者が実証、マリンが 068 を独立再現
- レビュー: マリン承認（28ファイル全 diff・IDB 書込全経路の追認・PCT-077 のTS側契約影響なし確認）
- QA 判定（トワ）: 自動ゲート合格・条件付き（①E2E 実行 ②lruIdbRoundtrip の実PDF実行 ③実機手動確認）
- E2E / soak: ※実行結果は末尾の追記参照

## 実機手動チェックリスト（Deep-Fix 追加分・トワ指定）

**A. 保存の正しさ（最優先・絶対ライン）**
1. 単一 rename 化後の上書き保存（PCT-077/078）: 保存後 PDF が Acrobat で開ける・サイズ妥当
2. 保存中クラッシュ復旧: 保存処理中にタスクキル → 再起動後、元ファイル無傷（temp 残骸は可）
3. 他アプリでロック中の上書き保存 → 「別名で保存」フォールバックトースト
4. 別ドライブ/ネットワークドライブへの SaveAs（cross-volume rename）
5. LRU 退避を伴う大型 PDF（51ページ超）の全ページ編集→保存→再オープンで全編集残存（PCT-068/070）
**B. undo/redo と復元（PCT-069）**
6. 編集→ページ移動→undo→保存→再オープンで表示と保存内容が一致
**C. ロード・メモリ（PCT-072/073）**
7. 100MB級ロード中に別ファイルを開く → 先行ロード中断・メモリ解放（タスクマネージャ）
8. PDF 10回連続開閉でメモリが単調増加しない
**D. 競合ガード（PCT-074/075）**
9. ロード中 Ctrl+S → 保存拒否トースト / 10. 保存中の別ファイルオープン → 読込中止トースト / 11. diff プレビュー中の Ctrl+S 連打 → 二重保存なし / 12. SaveAs ダイアログ放置→別経路保存→確定で進行中トースト
**E. OCR（PCT-076/079）**
13. バッチ中に OCR ゼロプロンプトが出ない・通常オープンでは従来どおり出る / 14. 極端なページサイズの OCR でクラッシュなし
