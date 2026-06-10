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
