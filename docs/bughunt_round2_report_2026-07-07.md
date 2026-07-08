# bug-hunt round2 レポート（2026-07-07）

対象: pecotool_v2 全体（round1 収束後の新観点狩り）。発見・裏取り・裁定は Fable、修正実装は Sonnet の分業で実施。
狩り観点: 保存パイプライン／store・hooks 契約／Rust・IPC 境界／設定・既定値／表示・描画・メモリ（＋Orchestrator 直接レビュー）。

## 修正済み（コミット）

| コミット | 内容 |
|---|---|
| a1b2899 | Wave1 (HIGH×6): 保存後処理 pageOrder 判定の TOCTOU 原子化／byte-preserve 時の normalize・IDB破棄・保存位置記録の素通り／deletePages・movePage の F-6 ガード hook 経路無効／delete undo による undoable=false OCR結果の恒久消去／render 失敗時の無通知ホワイトアウト（エラーUI条件矛盾）／private BBox メタの TextDecoder 非fatal（U+FFFD 正史化） |
| 1ede010 | Wave2 (MEDIUM×5): 非dirtyページ sweep・GC・compact 区間の heartbeat 追加（1000ページ誤terminate対策）／rotatePages・replaceText・replaceTextBatch への pageOrder 再検証横展開（epoch/filePath/pageOrder 3点セット規律）／runOcrOnRegion 多重起動ガード／別窓サムネ in-flight ガード＋generation 先バンプ修正／保存失敗 .pecotool-*.tmp の掃除経路新設（即削除＋mtime 10分 stale 掃除、保存成功時・オープン時配線） |
| 2a388b8 | Wave3/4: 複合検証枠（1000p×50BB 手動枠・120p×100BB CI常設枠、全数照合欠落0）／bitmapCache 内側LRUキー修正（zoom末尾化）＋巨大エントリ自己evict防止／サムネキュー二重並走解消（queueEpochRef 分離）／別窓 page-order-changed の差分remap化／file-opened 二重発火デデュープ／非表示窓への emit 保留／O(N) セレクタのメモ化 |

検証: critical 361緑・largescale 7/7緑（1000p×50BB=5万ブロック全数照合 欠落0・保存 cycle 9.2s/14.1s）・cargo test 91緑・tsc/eslint 新規指摘なし。

## 運用対応（コード外・ユーザー判断待ち）

| # | 重大度 | 内容 | 推奨対応 |
|---|---|---|---|
| OPS-1 | HIGH | updater 署名秘密鍵が repo 内 `keys/` に平置き＋空パスフレーズ疑い（release.ps1 の `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=''`）。別PCフォルダ同期運用と組み合わさると漏洩面が広い。git 履歴混入は無し（確認済） | パスフレーズ付きで鍵再生成→`~/.tauri` へ一本化→repo から秘密鍵撤去（.pub のみ残す）。updater 鍵差し替えはリリース手順に影響するため要ユーザー承認 |
| OPS-2 | MEDIUM | release.ps1 が秘密鍵の中身を環境変数でビルド全子プロセスへ継承（npm 依存のサプライチェーン侵害時に露出） | `-File` 起動固定＋try/finally で `Remove-Item env:TAURI_SIGNING_PRIVATE_KEY` |
| OPS-3 | MEDIUM | fs capability の静的ワイルドカード scope（$DESKTOP/$DOCUMENT/$DOWNLOAD/$TEMP 常時開放）。単体では脆弱性でなく「renderer 侵害時の被害拡大係数」 | dialog + persisted-scope の動的 scope だけで開く/保存が回るか実機検証後に縮小（PCT-118 の轍に注意） |
| OPS-4 | LOW | assetProtocol の stale scope（$APPDATA 系）＋$TEMP/** の asset 読み | convertFileSrc 使用箇所を grep し未使用エントリ削除 |
| OPS-5 | LOW | CI workflow に permissions ブロック未指定／Playwright trace の always アップロード | `permissions: contents: read` 明示。repo が private なら trace は現状維持可 |
| OPS-6 | — | apps/report-tool（サイドカー）は今回未監査 | round3 候補 |

## backlog（アプリ・未修正の残余候補）

### MEDIUM（次ラウンド優先）
| ID | 内容 | 該当 |
|---|---|---|
| B-1 | main-thread fallback 経路の保存直列化破れ（worker 不在時に並走保存が後勝ち上書きしうる） | pdfSaver.ts:255-264,374-385 |
| B-2 | 境界スペース Tw が Identity-H（CJK埋込フォント）に仕様上無効 — #100 連結抑止の効力低下。Acrobat 実機検証タスク付き | pdfSaverCore.ts:1020-1075 |
| B-3 | ブロック描画例外時に bboxMeta には書かれ content には描かれない乖離（skippedChars 未計上・ユーザー可視化なし） | pdfSaverCore.ts:1453-1467 vs 1687-1689 |
| B-4 | ページ切替窓中の世代混在 — 旧ページ絵の上に新ページ BB（回転ページで BB 位置も一瞬崩れ）。チラつき防止設計との両立要検討 | PdfCanvas.tsx:293-334 / usePdfRendering.ts:433-460 |
| B-5 | pdfjs destroyed 系エラーの silent return 前提が崩れる stale window（無通知ブランク静止）※推定 | usePdfRendering.ts:340-355 |
| B-6 | %TEMP% の OCR プレビュー PDF がセッション中蓄積（機密滞留） | lib.rs:628-667 |
| B-7 | バッチジョブと手動 OCR の相互排他なし（フラグが hooks 間で別世界） | useBatchJob.ts / useOcrEngine.ts / App.tsx:905 |
| B-8 | diff プレビューモーダル待機中のドキュメント切替を再検証しない（旧 filePath 宛て監査ログ・バックアップ削除） | useFileOperations.ts:1052-1078 |
| B-9 | 構造変更を含む保存で監査ログが空になる（normalize の undoStack クリア後に diff 計算） | useFileOperations.ts / saveDiffSummary.ts |
| B-10 | replaceText の pageOrder 不一致中止時、IDB には反映済みだが画面に出ない状態の UX 導線（R2-4 修正の残余） | pecoStore.ts（W2 修正コメント参照） |

### LOW（機会があれば）
- NaN/Infinity bbox の描画前検査（Number.isFinite 4点）／奇数長 hex の最終ニブル切捨て／BT跨ぎ q/Q 不均衡／ensureDenseClassicXref の /Size 超過脱落
- 監査ログ NDJSON の多重起動アトミック性／close ガードの上限保護／perf・operation ログの body サイズ上限／検証→rename の TOCTOU（ローカル攻撃者前提）／グレゴリオ暦境界テスト
- normalize が保存中編集の undo 履歴も破棄（仕様確認）／LRU purge の MRU 誤昇格／updatePageData ロールバックの epoch 未検証／schedulePendingIdbWrite の epoch ガード（afterPending 未使用の時限）／searchStore のファイル切替残留（仕様確認）／useBatchJob finalize の eager-state 依存／runReplace のデバウンス query（UI 確認）
- サムネ: LOAD_PDF 部分失敗で 1/3 恒久空白（リトライなし・両系統）／隠し窓の常駐メモリ（pdfjs 4複製）／dead handle 永続キャッシュ／dirty dedupe sentinel `''` 衝突（useThumbnailWindow 側は W4 で NUL 化済み、prevDirtyRef 側が残）／サムネキャッシュ eviction なし
- 描画: 選択 BB 自動スクロールの rotation 未考慮／Space 押下中 blur の stuck／zoom キャッシュミス時のブランクが render 完了まで継続／debounce 一本化による autoFit 50ms スキップ／altDrag ラベルの回転／render が dpr 未使用（HiDPI ボケ・意図確認先行）
- worker: SAVE_PDF 応答に requestId なし（防御単層）／thumbnail.worker の document スタブに fonts/head なし（実機確認先行）／差替時 doc.destroy() の unhandledrejection

### 棄却（理由付き）
- is_backup_stale の「サイズ不変=stale としない」: #364 の偽陽性不可方針に沿った意図的設計
- temp を fs scope で弾く強化案: PCT-118 で保存全滅の実績があり不採用
- CSP style-src 'unsafe-inline': React/framer-motion 依存で除去コスト過大、script-src は 'self' 維持のため受容

## 実機手動チェックリスト（自動緑≠実機OK領域）

1. [ ] 実 PDF の上書き保存／別名保存／Acrobat ロック中の保存フォールバック（保存先に `.pecotool-*.tmp` が残らない・stale 残骸がオープン時に消える）
2. [ ] 1000ページ級実 PDF: 保存中にサムネ並べ替え・回転を行っても保存後の状態が正しい（90°汚染・ページ入れ替わりなし）
3. [ ] undecodable メタ PDF（byte-preserve 対象）で並べ替え→保存: 警告トーストが出て、並べ替えが画面上で巻き戻らず、Ctrl+Z が効く
4. [ ] ページ削除→全ページOCR→Ctrl+Z: OCR 結果が消えない
5. [ ] 別窓サムネ表示中に上書き保存: perf ログで LOAD_PDF が 1 回のみ（二重発火解消）。窓を閉じて保存→再表示で最新化
6. [ ] 別窓サムネの高速スクロール往復: プレースホルダー固着なし
7. [ ] OCR 実行中に範囲 OCR ドラッグ: 拒否トースト表示
8. [ ] 巨大ページ×高 zoom で render 失敗を誘発した際にエラーオーバーレイ＋再試行ボタンが出る（発生困難なら省略可）
9. [ ] Windows 125%/150% スケール環境での文字シャープさ（dpr 未使用の現状確認・B系 backlog 判断材料）
10. [ ] OPS-1 鍵運用対応の実施判断（ユーザー）
