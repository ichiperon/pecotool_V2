# 計画書：保存・BB整合性 自律レビュー＆修正ループ

- 起案日: 2026-06-26
- ステータス: **計画（合意待ち）** — 本書合意後に着手。コード修正は隔離 worktree で実施。
- 対象: 本体 PecoTool（`src/**` の保存・BB焼き込み）＋ 帳票ツール（`apps/report-tool/**` の BB表示・CSV）
- 体制: Orchestrator（えーちゃん）＋ ホロデブ部マルチエージェント ＋ Codex クロスレビュー
- 由来: ユーザー要望「最低限できることの保証」7項目＋自律ループ、AI推奨の多フェーズ・パイプライン。部長会議（PM ココ／QA トワ／AIエンジニア みこ／御局 らでん）で設計。

---

## 0. このループの一文

> **「最低保証を破る失敗テストを先に固定し、それが緑になり既存に回帰を出さないことを機械的クローズ条件とする。ただし緑はクローズの必要条件であって十分条件ではない——保存・座標の実体験は実機 Acrobat の手動チェックでしか確定しないため、人間承認（HITL）をマージの絶対ゲートに置く。」**

---

## 1. 背景・前提・制約

### 1.1 最低保証ライン（出荷の最優先ゲート）
1. **保存の正しさ（絶対）** — OCRブロックが1件も欠落しない、ゴミ演算子混入なし。
2. **表示の正しさ** — ホワイトアウトなし、BB位置が正しい。

### 1.2 ユーザーが保証したい7項目
| # | 保証項目 | 責務 |
|---|---|---|
| 1 | OCRがある場合 BB が該当位置に表示され、テキストを本ツール上で確認できる | 本体＋帳票 |
| 2 | BB位置を変更し保存→その変更が PDF に反映される | 本体 |
| 3 | 保存データにゴミ（演算子）混入なし、Acrobat でエラーなく読める | 本体 |
| 4 | 本ツールの BB位置 と Acrobat Ctrl+A 選択位置が一致 | 本体 |
| 5 | 本ツールで変更したテキストが Acrobat で正しくコピペできる | 本体 |
| 6 | 数千ページ・1ページ数百BBが固まっていても保存が正しい | 本体＋帳票 |
| 7 | 同条件でスムーズにページ推移できる | 本体＋帳票 |

### 1.3 既知の足元事情（事実・メモリ由来）
- **E2E/単体の PDF 描画はモックで canvas 実描画なし** → ピクセル/幾何の実検証は不可。「自動緑 ≠ 実機OK」。
- **OCR/保存/IPC 変更は実機手動でしか出ないバグがある**（tauri build → 実機確認必須）。
- **LRU退避境界**（`pecoStore` の `MAX_CACHED_PAGES=50`）が保存欠落の最頻経路。別途 IDB 側キャッシュは `pdfTemporaryStorage`（800件/128MB, `pruneCachedPages`）。
- **別PCが本フォルダを同期しながら別タスク稼働中** → セッション中に branch切替/stash上書きが起きうる。
- **worktree 配下では Playwright E2E が「No tests found」で全スキップ**（隠しフォルダ無視）。**E2E は PR の CI に委ねる**。
- **テスト用の機密 PDF はコミット禁止** → 実PDF依存テストはローカル/手動でのみ。
- 過去事故: fs scope の temp 書込罠（PCT-118）型の「保存全滅」級リスクが実在。

### 1.4 実装アンカー（裏取り済み）
- 本体保存: `pdfSaverCore.ts:1001` `buildPdfDocumentCore` / `:1068` dirty収集 / `:1309` ブロック描画ループ / `:1390` Y軸反転 `baselineY - textOffsetDy`。
- ゴミ除去: `pdfContentStream.ts:630` `stripTextBlocks`（旧 BT…ET 除去）。
- メタ永続化: `pdfPecoToolMetadata.ts:126/149` bbox/writingMode/order を PDF stream へ。
- 保存前バリア: `pecoStore.ts` `waitForPendingIdbSaves()`。
- 帳票: `templateCsv.ts:49` `csvQuote`（formula injection 防御）/ `:89` `buildTemplateCsv`（列順・明細展開）、`useReportOcr.ts:74` `effectiveRectForPage`（ページ別オフセット）。

---

## 2. 保証7項目 → D/M 分離 受入対応表（計画の核）

**D = 決定論で自動化可（CIで毎周判定）／ M = 実機手動確認必須（Acrobat実物・実描画・実IPC）。**
原則：**「バイト構造・状態・抽出座標の整合」は D で赤固定できる。「ピクセル描画・実ビューア体験」は M。**

| # | 区分 | 何で保証するか | ゲート |
|---|---|---|---|
| 1 | **D** | PDF座標→viewport座標変換ロジック単体＋ `saveReloadRoundtrip`（loadPage復元） | MMP(state) |
| 1' | M | 実描画でホワイトアウトなし・BB目視一致 | RC手動 |
| 2 | **D** | `useBlockDragResize`（移動）＋ **新規: 移動後bbox == 保存bboxMeta 結合assert** | MMP(pdf) |
| 3 | **D** | `stripTextBlocks.repro` ＋ `acrobat7compat` ＋ **昇格: reachabilityGc系**（到達不能オブジェクト/孤児参照なし） | MMP(pdf) |
| 3' | M | 実 Acrobat で開いて警告/破損ダイアログが出ない | RC手動 |
| 4 | **D** | **新規: 保存→pdfjs `getTextContent().items[].transform` を再抽出し期待座標と `toBeCloseTo`**（＝Acrobat抽出座標と同源）。回転・縦書きを境界に | MMP(pdf) |
| 4' | M | 実 Acrobat Ctrl+A の実選択ハイライトと OCR下地の重なり（ピクセル） | RC手動 |
| 5 | **D** | `pdfSaverAcrobatWordBreak`（末尾不可視スペース Tj／pdfjs抽出で語が癒着しない）＋ `pdfSaverFallbackFonts` ＋ **新規: 編集後テキストの往復抽出一致** | MMP(pdf) |
| 5' | M | 実 Acrobat コピペの文字化けなし（IME・全角半角・縦書き選択順） | RC手動 |
| 6 | **D** | `goldenMasterLargeScale`（51=境界直上/120=大幅超・LRU跨ぎ no-loss）＋ `goldenMaster` ＋ **昇格: lruIdbRollback / infraStore eviction** | MMP(pdf) |
| 6' | M | 実数千ページPDFの保存完走・メモリ・所要時間 | RC手動/soak |
| 7 | **D** | `usePageNavigation`（遷移ロジック・状態） | MMP(state) |
| 7' | M | 実描画の体感カクつきなし | RC手動 |

> **重要**: D が全緑でも M（1',3',4',5',6',7'）は自動ループでクローズ不可。P1 は必ず RC手動チェックリストを踏んで Human-in-the-loop で判定する。**緑＝クローズの必要条件、M承認＝十分条件。**

---

## 3. minimum-must-pass set（MMP）＝ ループ毎周の緑判定母集団

### 3.1 MMP の定義
「保証7項目に直結」かつ「決定論（合成コーパス・モックpdfjs・jsdom）で**実PDF非依存**」かつ「毎周回せる速度」の3条件すべてを満たすものだけ。
**`skipIf(!hasRealPdf)` 系（realPdf*）と soak はループ内ゲートに入れない**（CIでskipされ「0 failed=緑」の誤緑を生むため）。

### 3.2 MMP の構成
- **ベース** = 既存 `test:critical`（= `test:pdf:acceptance` 11本 ＋ `test:state:acceptance` 4本）。
- **昇格（現在ゲート外 → MMPへ）**:
  - `lruIdbRollback.test.ts` — LRU退避時のIDB書込失敗→ロールバック整合（保存欠落の例外系・項目6）。
  - `pdfReachabilityGc.test.ts` / `pdfReachabilityGcWave7.test.ts` — 焼込後の到達不能オブジェクト/孤児参照なし（項目3の構造健全性）。
  - `infraStore` の eviction（MAX_CACHED_PAGES=50 退避順序の単体・項目6上流）。
- **新規3本（§4）**: 項目4 座標再抽出 / 項目2 移動後bbox反映 / 項目5 編集後コピペ往復。
- **新スクリプト案**（命名は建設部と調整）: `test:lru:acceptance`（lruIdbRollback＋infraStore eviction）、`test:struct:acceptance`（reachabilityGc系）を `test:critical` に合流。

### 3.3 ゲート階層と役割分担
| ゲート | 中身 | 役割 | 頻度 |
|---|---|---|---|
| **MMP（拡張 critical）** | 上記。実PDF非依存・決定論 | failing-first ループの**緑判定** | ループ毎周 |
| 広域 `npm test`（≒2255）＋ `cargo test` | 全モジュール | 想定外の巻き込み破壊・ゲート外guard（capability整合等）の網 | RC/PR前 |
| soak（realPdf*, loadTest500Pages） | 実バイト・大規模・実IDB | 近似。**実PDF無しCIでは自動skip＝ゲートにしない** | nightly/手動 |
| E2E（Playwright+Tauri） | 起動シナリオ | **worktreeでは走らない → PR の CI に委ねる** | PR CI |

---

## 4. 不足テストの新規設計（failing-first・赤を先に立てる）

各テストは「最低保証を破る状態」を赤で固定。コミット時に**仕様の根拠**（Acrobat仕様・既存動作のスクショ・過去Issue番号）をファイル冒頭コメントに必須記入（誤仕様固定＝wishful-thinking test の防止）。

| 新規 | 赤で固定する破壊状態 | 対象 | assert観点 | 既存 |
|---|---|---|---|---|
| **N-4 座標再抽出** | 保存→pdfjs再読込の `item.transform[4],[5]` が期待座標から許容超でズレたら赤 | `pdfSaver` Tm生成 → pdfjs `getTextContent` | 合成PDF生成→読み戻し→`toBeCloseTo(expX,expY)`。横/縦/回転(0/90/180/270)を境界 | 往復一致は済、**描画→抽出座標は新規** |
| **N-2 移動後反映** | ドラッグでbbox変更→保存メタ/Tmが旧座標のまま | `useBlockDragResize` → `pdfSaver` | 移動後bbox == 保存bboxMeta == 再抽出座標 | 移動単体は済、**保存反映結合は新規** |
| **N-5 編集後コピペ** | テキスト編集→再保存→pdfjs抽出が**変更後文字列**にならない/語が癒着 | `pdfSaver` + findReplace結合 | 抽出文字列が編集後と一致＋隣接BBに区切りTjあり | 配置主体は済、**編集差分往復は新規** |

> N-4 は本計画の肝。**Acrobat Ctrl+A が読むのは content stream の Tm 行列であり、pdfjs `item.transform` と同源**。よって座標一致の大半が canvas 非依存・実PDF非依存で決定論化できる。残差（実Acrobatのピクセル重なり）だけ手動（4'）。

### 4.1 ストレッチ（任意・別CIジョブ）
実 Tauri バイナリ＋プログラム生成の合成PDF（機密でない）で「OCR BB四隅 == 実描画抽出座標 ±N px」を検証する独立 CI ジョブ。**worktree では走らないため通常ループには組まず**、GitHub CI 側の別ジョブに置く。N-4 が即時ゲート、こちらは将来の上積み。

---

## 5. 4フェーズ・パイプライン（finder ≠ fixer ≠ verifier）

認知バイアス（自分の修正を正しいと思い込む）を物理分離で潰す。フェーズ間でエージェントを使い回さない。

| Phase | 目的 | 担当（subagent_type） | 実装 |
|---|---|---|---|
| **1 Discovery 発見** | 候補を広く探索 | 静的解析=`devops`／意味探索=`reviewer`／境界・注入=`reviewer_security`（並列） | **Workflow**（schema強制・並列） |
| **2 Triage & PoC 再現** | 候補が真のバグか、**赤テスト**で確認 | `tester_unit`＋`tester_integration`＋`codex:rescue`（独立検証） | **Orchestrator手動ループ**（テスト実行の副作用＋Codex分岐のため） |
| **3 Patching 修正** | 赤を緑に、既存を壊さず | `coder_frontend`／`coder_backend`（Phase1の finder とは別召喚） | **手動ループ（最大3回）** |
| **4 Verification 検証** | 新しい目で妥当性確認＋PR | `qa_lead`＋`reviewer_architecture`＋`codex:rescue`＋`tech_lead`（PR） | **Workflow**（並列＋Codex後続） |

- finder/fixer 分離の担保：Phase1 のエージェントは Phase3 に呼ばない。同 subagent_type でも**別 Agent 呼び出し＝別コンテキスト**。
- Phase4 の検証者には Phase1-3 の会話履歴を渡さず、`latent-briefing` で生成した**サマリのみ**を渡す（「直したつもり」バイアス遮断）。
- レビュー隊（Phase1 意味探索・Phase4 検証）は **`model: fable` 指定**（メモリ運用方針）。

---

## 6. ハードリミットとエスカレーション

| 制御軸 | 既定値（提案） | 動作 |
|---|---|---|
| 1 issue あたり最大修正ループ | **3回** | 4回目に入る前にエスカレーション |
| 累積トークン上限（1 issue） | **150K** | 超過で即エスカレーション |
| Phase 単体タイムアウト | **5分** | テスト実行込み |
| 同一ファイル修正回数 | **3回** | 超で「問題を理解していない」フラグ→エスカレーション |
| 同一テストが連続赤 | **3周** | ストップ条件 |
| エスカレーション条件 | 上記いずれか **OR Codex不一致** | 即人間へ差し戻し（理由・再試行条件・期限をissueに残す） |

無限ループ検知＝`patch_count[file]` を Orchestrator が累積カウントする辞書で判定（DSL不要）。

---

## 7. Codex クロスレビューの差し込み点

| 差し込み | 問い | 狙い |
|---|---|---|
| **Phase 2** | 「この赤テストは本当に元のバグを再現しているか？ 過剰アサート/誤検知ではないか？」 | 赤テストの妥当性を Claude 判断から独立 |
| **Phase 4** | 「この修正は正しいか？ 副作用は？ **テストに過適合していないか**？」 | 修正の妥当性を fixer から独立 |

**不一致時の裁定**: Claude承認/Codex拒否（逆も）→ **自動マージ禁止・人間エスカレーション**。第3のAIに裁定させない（責任拡散を避ける）。

---

## 8. issue 優先度ルーブリック

| 優先度 | 基準 | 扱い |
|---|---|---|
| **P1** | 最低保証ライン直撃（保存欠落・ゴミ混入/Acrobat開けない・座標ズレ・テキスト化け・大規模保存破綻・ホワイトアウト） | 出荷ブロッカー。failing test 先行＋計画に人間承認必須 |
| **P2** | 機能成立だが品質低下・回避策あり・**保存は正しい**（一部ページBBずれ、ページ送りカクつき、特定テンプレ帳票CSV欠落） | 次ループ内対応＋回帰テスト追加 |
| **P3** | 軽微UX・cosmetic・稀エッジ（保証7項目非該当） | backlog化 |

**非対称な安全側倒し**: 「保存 or 座標 or 文字内容に少しでも影響」が疑われたら**まず P1 として査定を始める**。

---

## 9. Go/NoGo ＆ Human-in-the-loop

```
レビュー → issue起票 → [HITL-1 トリアージ承認] → 修正計画 → [HITL-2 計画承認]
       → 修正 → 再レビュー → ゲート判定 → [HITL-3 マージ承認] → クローズ
```

| ポイント | 人間承認 | 判定 |
|---|---|---|
| HITL-1 起票後 | P1必須（P2/P3は自動＋事後監査） | 優先度妥当性・重複/無効除外・スコープ |
| HITL-2 計画後 | **P1必須** | 根本原因に当たっているか・赤テスト先行・回帰範囲 |
| HITL-3 マージ前 | **常に必須** | クローズ条件＋ M手動チェックリスト |

**クローズ条件（全て満たす）**:
1. 事前用意の failing test が **100%パス**（D項目）。
2. 既存 ≒2255 ＋ MMP に **回帰ゼロ**。
3. RC級は広域 `npm test` ＋ `cargo test` 緑。
4. P1 は **M手動チェックリスト**完了（Acrobat実開封/Ctrl+A/コピペ・実機大規模）。
5. **再レビューで新規issueゼロ**（§10 の cooling 条件込み）。
6. HITL-3 人間承認取得。

**承認フォーム必須項目（形骸化防止）**: 承認者は最低限 ①保存テストPDFを開き OCRブロック件数を目視確認 ②表示して BB が枠外に出ていないか確認 のチェックを入れないと承認不可。承認時に「何を見たか」を記録に残す。

---

## 10. 「時間を空けた新しい目」の再レビュー設計

単なる再実行にしない。同一モデル・同一プロンプトでは同じ盲点を踏む（茶番化）ため、差分を作る：

- **観点とモデルをローテート**: 前回と別の reviewer 系＋`model: fable`、かつ **Codex** を 2回目に投入。
- **逆問い**: 「前回の指摘リストを渡した上で、**これ以外に何があるか**」を問う。
- **クリーンコンテキスト**: 前回の結論・前提を引き継がず、仕様（7項目）と diff だけを渡す。
- **cooling を時間でなくイベントで定義**: 「修正直後」は不可。**Nコミット後 or 次ループ**まで空け、その間に別issueを挟む（直後クローズを構造的に禁止）。`schedule` で時間分離・`loop` でポーリングを使い分け。
- **clean に有効期限**: 1回 clean では昇格しない。**2ループ連続で新規issueゼロ**で初めて「再レビュー合格」。
- **恒久化**: 発見した実バグは golden corpus / failing test に**恒久追加**し、同じ穴を機械検出へ変える。

---

## 11. 静的解析ゲート（Linter / SAST）

決定論ゲートとして **Phase1 先頭**（ベースライン）と **Phase4 末尾**（回帰）に配置。Phase3 ループ内には入れない（誤検知でループが詰まる）。

- **TS**: `eslint`（JSON出力）＋ `tsc --noEmit`。Phase1 で件数ベースライン、Phase4 で新規警告増を `regressions` へ。
- **Rust**: `cargo clippy -- -D warnings` ＋ `cargo test`。
- **要手当て**: ルートに `lint`/`typecheck` の npm スクリプトが**未配線**（`eslint.config.js` はあるがスクリプトなし、typecheck は `build` の `tsc` 経由）、`apps/report-tool` も `test` のみ。**着手時に `lint`/`typecheck` スクリプトを追加**（apps/限定・本体 build 無改変）。

---

## 12. 作業隔離・別PC同期・worktree ガード

- **隔離**: 修正は `git worktree` の専用ブランチで実施。レビュー・起票・本計画は読取中心。
- **commit 規律**: `apps/` 限定 add を基本、本体 `src/**` を触る修正は別コミット・別レビュー。commit 前に必ず branch/stash 確認（別PC同期ハザード）。
- **フェーズ毎ガード**: 各フェーズ開始時に `git status --short` と `git rev-parse HEAD` をログ。前フェーズから予期せぬ差分があれば**ループ自動停止→ユーザー委譲**（「緑」を git 状態ではなくメモリ上の主張にしない）。
- **E2E**: worktree では走らない（No tests found 全スキップ）。**E2E は PR の GitHub CI に委ねる**。worktree ループ内では MMP（unit＋integration＋cargo）まで。

---

## 13. Goodhart・誤緑・誤仕様固定への制度的対策（御局の指摘を機構化）

| リスク | 対策（機構） |
|---|---|
| **Goodhart**（テストを緑にする最短経路で品質を下げる） | **テスト本体（assertion/mock/前提）を変更した差分は auto-merge 不可**＝人間レビュー必須を CI required check に。許容値・期待件数は定数化し diff レビュー。 |
| **誤仕様固定**（wishful-thinking test） | 失敗テストに**仕様の根拠コメント必須**（Acrobat仕様・既存動作スクショ・過去Issue番号）。根拠なきテストは reject。 |
| **誤緑: skipIf を緑と誤認** | MMP に realPdf*/soak を入れない。CIで skip 数を可視化、`skip>0` なら手動チェックリスト必須を運用ゲート化。 |
| **誤緑: stale embed / stale dev鯖** | ビルド前 `src-tauri` touch＋後で asset名 grep、E2E前に port1420 の残存 vite を kill。 |
| **誤緑: 往復一致==実描画 の取り違え** | N-4（描画→pdfjs抽出座標）を「保存メタ往復一致」と**別立て**。 |
| **同一盲点の再現** | §10 の観点/モデルローテート＋Codex＋逆問い。 |
| **HITL 形骸化** | §9 の承認フォーム必須チェック項目。 |

---

## 14. 帳票ツール側（read-only / CSV / BB表示）の最低テスト観点

本体ほどの保存保証は不要（PDF無改変）。最低ライン：
1. **CSV出力＝入力データの非破壊・正しいエンコード**（区切り/エスケープ/改行/BOM）— `templateCsv.test.ts`。
2. **read-only 不変則を1本明示**（帳票操作が元PDF/本体状態を書き換えないことの assert）— ※現状の明示assert有無は着手時に確認。
3. **BB表示のページオフセット整合** — `reportStore.pageOffset.test.ts` ＋ `useReportOcr`。
実描画/実Acrobat は本体側ゲートに委譲。

---

## 15. 未確定事項（着手前にユーザー合意）

1. **M手動チェックリストの実行者**：Acrobat実開封/Ctrl+A/コピペ・実機大規模は人間が回す必要。完全自律と矛盾する唯一の点。提案＝AIが「ビルド済バイナリ＋チェックリスト」を用意し、HITL-3 でユーザー（または指名者）が実行・記録。 → **要決定**
2. **ハードリミット既定値**（§6: 3回/150K/5分…）でよいか。 → 既定で進めるなら可、調整あれば指摘。
3. **新スクリプト命名**（`test:lru:acceptance` / `test:struct:acceptance`）と `test:critical` 合流の可否（建設部調整）。
4. **数千ページ（項目6）の上限**：決定論ゲートは 51/120 で不変則固定、真の数千は soak/手動。これで合意か。

---

## 16. 次アクション（合意後）

1. 隔離 worktree 作成（専用ブランチ）＋ フェーズ毎 git ガード導入。
2. **Phase 1 Discovery を Workflow で起動**（静的解析＋意味探索＋境界探索、schema強制・並列）。
3. 候補を P1/P2/P3 トリアージ → HITL-1。
4. P1 から **Phase 2（赤テスト＋Codex）→ Phase 3（修正・最大3回）→ Phase 4（検証・Codex・PR）**。新規3本（N-2/N-4/N-5）と昇格3系を MMP に組み込み。
5. クローズは §9 条件＋ M手動チェックリスト＋ HITL-3。
6. 2ループ連続で新規issueゼロ＋ M完了で当該領域を「再レビュー合格」。golden corpus に恒久追加。

---

### 付録: 参照
- `docs/TEST_REQUIREMENTS.md`（保存無欠落の番人・ゲート構成）
- `docs/plan/report-tool-sidecar.md`（帳票サイドカー設計・本体無改変方針）
- メモリ: リリース最低保証ライン / 実機手動でしか出ないIPC・OCRバグ / 別PC同期ハザード / worktree E2E制約 / 誤緑（skipIf・stale embed）
