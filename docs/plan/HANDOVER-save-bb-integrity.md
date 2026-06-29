# 引継書：保存・BB整合性 自律レビュー＆修正ループ

- 更新日: 2026-06-29
- 担当（前任）: Orchestrator（Claude / えーちゃん）セッション
- 目的: このループを別セッション／別PCがそのまま再開できるようにする
- 関連ドキュメント:
  - 親計画: `docs/plan/save-bb-integrity-review-loop.md`（D/M分離・MMP・4フェーズ・ガバナンス）
  - 発見記録: `docs/plan/save-bb-integrity-discovery-round1.md`（33候補→3起票の全記録・反証理由つき）
  - 帳票設計: `docs/plan/report-tool-sidecar.md` / 自動テスト要件: `docs/TEST_REQUIREMENTS.md`

---

## 0. 一行サマリ（現在地）

Discovery ラウンド1完了 → NEW3件を起票（#388/#389/#390）→ **3件とも修正済み・テスト緑・回帰なし・Claude＋Codex 両者 APPROVE**。

> **更新（2026-06-29 セッション2）**: §1 完了。6ファイルを2コミット（`8d97660` report-tool / `341e7f0` 本体pdf）し `fix/save-bb-integrity-round1` を push、**ドラフトPR #391**（base `feature/report-tool-sidecar`）作成済み。**#388 follow-up は #392（PCT-161）として起票済み**。再検証: 帳票 503緑 / test:critical 119+1skip・135緑 / #388単体 11緑 / 6ファイル実diff裏取り済み。WIP・stash 無傷。
> **Discovery Round 2（cooling 再レビュー）完了**: クリーンではなく **確定P1×4＋P2×1 を新規発見・全件起票**（#393 rotate undo/redo IDB / #394 replaceText write live pageOrder / #395 CSV %腐敗 / #396 saveAllPagesWithOffset no-op / #397 q/Q不均衡）。うち **#395 はこのPR #391 で failing-test-first 修正済み**（commit b7dde0f・帳票507緑）。#393/#394 は pecoStore WIP-blocked、#396 は設計判断要(HITL-2)、#397 は core save path の別対応。残る §4-③MMP拡張・§4-④#360 は package.json/pecoStore/infraStore が別作業WIP中のため blocked。マージは HITL-3（実機Acrobatサニティ）まで保留。
> ⚠️ **Round 2 の教訓**: dedup の却下キーワードフィルタ（'word-break'/'縦書き'）が、却下済みと語が被るだけの**別機構の実バグ（#397 q/Q不均衡）を一旦誤ドロップ**した。workflow が log に残していたため Orchestrator が拾って裁定・起票。**キーワードフィルタの drop は必ず log し再裁定する**（silent drop 禁止）。
> 💡 **未検証の手動キュー（needsRealMachine）**: setWordSpacing(Tw) が CID サブセットフォントの空白で効かず #100「案A」の word-break が日本語で無効化される疑い（保証#5・copy-paste）。実Acrobatでしか確認できないため新規起票せず、HITL の実機サニティ時に「日本語OCRをCtrl+Aコピーして語が癒着しないか」を確認する手動項目として残す。
>
> **更新（2026-06-29 セッション3・現在地リセット）**: 状況が §1〜§4 の記述を追い越した。`fix/save-bb-integrity-round1` / HEAD `5e30b7d` / origin と 0 ahead 0 behind。
> - **保存/BB修正は #388/#389/#390/#395 に加え #397（q/Q不均衡・`5e30b7d`）も commit 済み・全て push 済み**。§1 の「6ファイル未コミット」「#397 別対応 pending」は **完了済みで obsolete**（§1 の再開コマンドは実行不要）。
> - 本セッションは「別作業WIP（本体ストレージ監視＋MMPテスト拡張）」と新規保存テストを5コミットに整理（**未 push**）: `97a1e2d` feat(storage) 逼迫警告バナー / `9e4c627` test(save) LRU×大規模の番人を test:critical 昇格（goldenMasterLargeScale＋lruIdbRollback 合流） / `ab079ad` chore(ci) コアカバレッジ warn / `826b6d0` docs(plan) 本書含む計画/発見の整備 / `ad4ae6a` test(save) N-2/N-4/N-5＋縦書き×回転を test:critical 昇格。再検証: **test:critical 20ファイル 275緑+1skip・回帰なし / 広域 npm test 緑0fail**。
> - ⚠️ **stash@{0} 衝突（保存パス）**: `stripStrayTextOperatorsOutsideTextObjects` の実装は **feat/save-force-cleanup-toggle（stash@{0}・別PC稼働）が所有**（pdfContentStream +146行＋sweepNonDirtyPage 配線＋pdfSaverCore）。本ブランチの `stripStrayTextOperators.test.ts` は **describe.skip で保留**。**ここで再実装しないこと**（保存パス関数を2ブランチに二重実装＝分岐回避）。当該ブランチのマージで impl が入った時に skip を外す。
> - ✅ **MMP §4 item3 進捗**: 新規3本 **N-4 座標再抽出 / N-2 移動後反映 / N-5 編集後コピペ** と **縦書き×回転回帰** を作成・全green・test:critical 合流済み（commit `ad4ae6a`・4ファイル17ケース・グラウンドトゥルース導出→作成→敵対的検証で誤仕様固定を回避）。残るは **reachabilityGc/infraStore eviction の合流** と、pecoStore大型WIP待ちの **#360/#393/#394**（今回の pecoStore 差分は `MAX_CACHED_PAGES` export 1行のみで無関係）。
> - 📐 **座標モデル確定（計画 §4 の "PDF_y reduce" は誤りと判明）**: 保存→pdfjs `transform[4]/[5]` 再抽出の実測で、**横書き R=90 の advance は +PDF_y（transform[5]増加）・transform[4]一定**、**縦書き R=90 は +PDF_x・transform[5]一定**。計画 §4 item3 の「R=90 で PDF_y reduce」は誤り（実際は増加・横/縦で送り軸が直交）。根拠 `getRotationCm`（pdfSaverCore.ts:566-583）。新4テストはこの真値で固定（`saveCoordReextract`/`saveVerticalRotationRegression`）。**注意**: `reloadBBoxMetaViaPdfjs` は永続JSONを返すだけで cm/baseline の座標バグを素通しする＝座標モデルは必ず transform 由来経路（`buildPecoDocumentFromRealPdf` / content-stream cm）で縛ること。
> - 📌 **push 判断保留**: 上記3コミットは PR #391（base `feature/report-tool-sidecar`・「保存BB整合ラウンド1+2」）の scope を広げる（storage監視は別機能）。push 前に「別ブランチ/別PRに分けるか」をユーザー判断。

---

## 1. ✅ 完了済み：保存/BB修正のコミット（記録として保持）

> **このセクションは完了済み**（セッション2で帳票/本体6ファイルを commit・push、#397 もセッション間で `5e30b7d` として commit 済み）。下記の「再開コマンド」は **実行不要**。現在地は §0 のセッション3ブロックを参照。以下は経緯記録。

### 状態（2026-06-29 実測・当時）
- ブランチ `feature/report-tool-sidecar` / HEAD `518a42b` / `fix/save-bb-integrity-round1` は**未作成**。
- 下記6ファイルが **Modified（未ステージ・未コミット）** で作業ツリーに健在。
- 作業ツリーには**別作業のWIP**（本体ストレージ監視＝`src/store/pecoStore.ts`・`infraStore.ts`・`App.tsx`・`StorageHealthBanner*`・`useStorageQuotaMonitor*`・`goldenMasterLargeScale.test.ts`・`lruIdbRollback.test.ts` ほか、計28ファイル）も同居。**WIPは触らない**。
- stash 2件（`stash@{0}` 別PCのAcrobat演算子修復WIP / `stash@{1}` サイドカーWIP）も**触らない**（pop/apply禁止）。

### コミット対象6ファイル（これだけをステージする）
**帳票（report-tool）= #389/#390**
- `apps/report-tool/src/hooks/usePdfShortcuts.ts`（修正）
- `apps/report-tool/src/logic/normalize.ts`（修正）
- `apps/report-tool/src/__tests__/hooks/usePdfShortcuts.test.ts`（赤テスト追加）
- `apps/report-tool/src/__tests__/logic/normalize.test.ts`（赤テスト追加）

**本体（main）= #388**
- `src/utils/pdfPecoToolMetadata.ts`（修正）
- `src/__tests__/unit/pdfPecoToolMetadata.test.ts`（赤テスト追加）

### 再開コマンド（コピペ可・WIPを巻き込まないようパス限定 add）
```bash
cd /c/Users/user/Desktop/workspace20/pecotool_v2
git switch -c fix/save-bb-integrity-round1   # 未コミットWIPは作業ツリーに残る（同一HEADから分岐）

# commit A: report-tool (#389,#390)
git add apps/report-tool/src/hooks/usePdfShortcuts.ts apps/report-tool/src/logic/normalize.ts \
        apps/report-tool/src/__tests__/hooks/usePdfShortcuts.test.ts apps/report-tool/src/__tests__/logic/normalize.test.ts
git commit -F - <<'EOF'
fix(report-tool): オフセット微調整の矢印キー二重発火と△負号の二重マイナスを修正 (#389, #390)

- usePdfShortcuts: adjustOffsetモード中は矢印キーをページ移動から除外し、
  OffsetAdjustOverlay の nudge と二重発火しないようにする (#390 / PCT-160)
- normalizeNumeric: △/▲由来の負号は本体が既に '-' 始まりなら前置せず、
  "△-50000" → "--50000" の値破壊を防ぐ (#389 / PCT-159)
- failing-test-first（赤テスト先行）。帳票テスト 501 緑

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF

# commit B: main pdf (#388)
git add src/utils/pdfPecoToolMetadata.ts src/__tests__/unit/pdfPecoToolMetadata.test.ts
git commit -F - <<'EOF'
fix(pdf): 配列形式 /Filter [/FlateDecode] を inflate してBBoxメタ喪失を防ぐ (#388)

外部ツールの再保存で /Filter が配列形式に正規化されると decodeRawStream が
null を返し、BBoxメタが空 {} で永続上書きされて OCR BBox が消失していた。
resolveFilterName で単一要素配列を単一名へ正規化して inflate する。
複数フィルタチェーンは従来どおり null（安全側）。test:critical 緑

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF

git status --short   # WIP（pecoStore等）が未コミットで残ることを確認
# push & 下書きPR（base は feature/report-tool-sidecar）
git push -u origin fix/save-bb-integrity-round1
gh pr create --draft --base feature/report-tool-sidecar \
  --title "fix: 保存・BB整合性ラウンド1（#388 BBoxメタ喪失 / #389 CSV値破壊 / #390 矢印二重発火）" \
  --body "Phase1 Discovery で発見・Claude＋Codex両者APPROVE済みのP2修正3件。各 failing-test-first。#388は保存メタ経路に触れるためマージ前にAcrobat実機サニティ確認推奨（HITL-3）。"
```

> マージはしない。**HITL-3（人間の実機Acrobatチェック＋マージ承認）が必須**。#388は保存メタ経路に触れるため、別名保存→Acrobat開封→Ctrl+A／コピペのサニティ確認を1回挟んでから merge。

---

## 2. 完了済み（フェーズ別）

| フェーズ | 状態 | 結果 |
|---|---|---|
| 計画合意 | ✅ | スコープ=本体＋帳票／ハードリミット5回・300K／隔離worktree方針／Codex併用／M実行者=AIが用意・ユーザーがHITL-3で実行 |
| ベースライン | ✅ | `test:critical` 119+1skip / 135 緑、帳票 498 緑（健全な土台） |
| Phase1 Discovery | ✅ | 9観点並列バグ狩り→既存issue突合→敵対的検証。33候補→worklist29→検証16→**is_real 4** |
| 起票（HITL-1） | ✅ | NEW3件 **#388/#389/#390** 起票（確定P1なし＝両P1候補は発火条件が狭くP2へ降格） |
| 縦書き+回転P1の検証 | ✅ | **Codex＋Claude 両者一致で NOT-REAL（コード正常）**。残るは縦書き×回転の回帰テスト空白のみ |
| Phase2 修正（3件） | ✅(未コミット) | #388/#389/#390 を failing-test-first で修正。帳票501✓ / test:critical 119+135✓ / 両app tsc✓ |
| Phase4 独立検証 | ✅ | reviewer（マリン）APPROVE 0.85 ＋ Codex APPROVE。差し戻し必須ゼロ |
| コミット/PR | ✅ | commit `8d97660`(report-tool)/`341e7f0`(本体pdf)・push・**ドラフトPR #391**（base feature/report-tool-sidecar）。マージはHITL-3保留 |
| #388 follow-up 起票 | ✅ | **#392（PCT-161）** 起票（保存側の空メタ上書き構造） |
| Discovery Round 2（cooling） | ✅ | 8観点finder→3観点検証(P1-until-disproven)。確定P1×4＋P2×1（#393-#397）。**1周クリーンならず**＝再レビュー合格は次周以降 |
| Round 2 確定の修正 | ⏳ | #395 のみ修正済(PR #391・b7dde0f)。#393/#394/#360 WIP-blocked・#396 設計判断・#397 別対応 |

---

## 3. GitHub issue 状況（repo: `ichiperon/pecotool_V2`）

### 起票済み（このループで作成）
| # | PCT | 内容 | 保証 | sev | 状態 |
|---|---|---|---|---|---|
| #388 | PCT-158 | decodeRawStream 配列Filter未対応→BBoxメタ喪失 | 3 | medium | 修正済(未コミット) |
| #389 | PCT-159 | normalizeNumeric "△-50000"→"--50000" 値破壊 | 3 | medium | 修正済(未コミット) |
| #390 | PCT-160 | adjustOffset 矢印キー二重発火 | 7 | high | 修正済(未コミット) |

### #388 follow-up（#392 / PCT-161）— **Stage1 完了・Stage2 は要再対応（Round3 指摘）**
ユーザー合意（HITL-2）で「read 境界 first-class ＋可視警告」を採用。**Stage1（データ保護）は堅牢に完了。Stage2（透明化バナー）は Round3 で配線欠陥が判明し再対応が必要**。
- ✅ **Stage1（保存パス・完全 byte-preserve）** commit `7a9d26c`: `readPecoToolBBoxMetaWithStatus` が `'ok'|'undecodable'|'empty'` を返す（legacy が読めれば 'ok'(legacy) 優先で旧 `private ?? legacy ?? {}` を温存）。pdfSaverCore は status==='undecodable' のとき **meta も content も触らず原本バイトをそのまま返す**。空・partial・準空の全経路で喪失ゼロ・乖離ゼロ。saveUndecodableMetaPreservation が保存バイト全体の原本一致を assert。reviewer_security/architecture APPROVE・critic の「meta だけ温存は content と乖離」反証を byte-preserve で解消済み。**＝ファイルの破損/喪失は起きない（出荷ゲート①は守られる）**。
- ⚠️→✅ **Stage2（透明化）は Round3 で欠陥クラスタが判明し、再設計＋ブロッカー是正で機能化**:
  - Round3 が「バナーが実フローで発火しない（onUndecodable が applyOffsetAllPages 限定＋cache バイパス＋reset 欠落＋dismiss 永久消滅）」を confirmed。
  - **再設計 `7dbc884`**: 検出を usePageNavigation の初回 meta ロード（通常オープンの唯一の meta 経路）へ移管＋cache に undecodable 保持で cache-hit でも再通知。reset を open(handleOpen)/close(handleClose) に集約。バナー恒久化（dismiss 廃止）。
  - **再レビューで出荷ブロッカー発覚→是正 `dab6297`**: byte-preserve はターゲットパス非依存で**別名保存も編集を落とす**のに、旧バナーは「別名で書き出して」と虚偽案内し別名保存は成功トーストを出していた（silent loss の新経路・①違反）。文言を「閲覧のみ・保存できません」に正し、全保存経路（handleSave/executeSaveAs/saveAllPagesWithOffset）で undecodable×未保存編集なら成功トーストを出さず警告。usePageNavigation の onUndecodable を epoch ガード（A→B 切替の stale 誤バナー解消）。reader 整合テスト U-PM-16。
- 🔜 **残（architect/PM 判断・次タスク）**: ①警告を UI フラグ依存でなく **`_executeSave`/SaveResult に `undecodablePreserved` フラグ**を返して全 caller が save の真実から一貫警告（reader 二重化の脆さを構造的に解消）。②**別名保存を真の escape hatch にするか**（undecodable のとき読めない stream を捨てて編集つき新規 PDF を再構築する saver モード）＝product 決定。
- ✅ **テスト false-green 修正**: lruIdbRollback（実退避 page1 を検証）`39aa2f8` / U-SQM-05（fake timers で dedup 実検証）`517e907`。**未対応(低優先)**: saveVerticalRotationRegression R=270（items 1件で空ループ・R=90 b2 と始点 assert で部分カバー）/ goldenMasterLargeScale（集約経路 _executeSave 未実行・useFileOperations.test.ts で別途カバー）。
- 防御の残置: write 内の空メタガード（`03a8e4b`）は last-line defense として保持。
- **既知の narrow ギャップ（許容）**: 破損 legacy Info(plain string) は status='empty' で preserve されない（旧形式・破損は稀）。
- クローズ判断: Stage1 完了。issue クローズは Stage2 再対応＋PR マージ＋HITL-3 後。

### 既存issueと重複/関連（Discovery で確認・補強候補）
- **#360**（pecoStore非同期ガード）: `replaceText(scope='all')` が `waitForPendingIdbSaves` 前に `getAllTemporaryPageData` を読み、LRU退避ページが一括置換から無音スキップ→保存欠落（`pecoStore.ts:1213-1239`）。**実P1相当**。ただし `pecoStore.ts` は未コミットWIP中 → **WIP確定後**に着手。
- #366（golden 2サイクルが再構築でない）/ #361（remap失敗サイレントcatch・`useFileOperations.ts:864-869`）/ #362（PdfCanvas自動スクロールが回転無視）/ #367（縦書き×回転テスト空白＝バグではない）も file:line と失敗テスト案あり（発見記録 参照）。コメント補強は任意・要承認。

---

## 4. 次にやること（優先順）

1. ~~**§1 のコミット → ドラフトPR**（3件）~~ ✅ 完了（PR #391・マージはHITL-3まで保留）。
2. ~~**#388 follow-up を起票**~~ ✅ 完了（#392 / PCT-161）。
3. **MMP拡張（task #5）**: 計画§4の昇格3系（`lruIdbRollback`/`reachabilityGc`/`infraStore eviction`）を `test:critical` 合流＋新規3本（N-4座標再抽出/N-2移動後反映/N-5編集後コピペ）＋**縦書き×回転の回帰テスト**（期待値は検証トレースに従う：R=90で advance は +PDF_x・PDF_yほぼ一定。提案主張の「PDF_y reduce」は誤り）。
4. **#360 replaceText の実P1**（保存欠落）: WIP（pecoStore）確定後に failing-test-first で。
5. ~~**再レビュー（task #7・cooling）**~~ → **Round 2 実施済み（セッション2）。新規 P1×4＋P2×1 を発見＝1周目はクリーンならず**。plan §10「2ループ連続で新規issueゼロ」の合格条件は未達。次周（Round 3）は #393-#397 の修正反映後に、観点をさらにローテートして実施する。発見バグは golden corpus / failing test へ恒久追加（#395 は済）。
6. **Round 2 確定バグの処理（優先順）**: (a) #395 ✅修正済(PR #391) → (b) #397 q/Q不均衡を core save path で try/finally 修正（P2・failing-test-first・test:critical回帰確認） → (c) #396 saveAllPagesWithOffset は設計トレードオフ（isDirty を立てる vs 原本メタ破壊回避）を HITL-2 で決めてから → (d) #393/#394 は pecoStore WIP 確定後（#360 と同じ待ち）。

---

## 5. 注意・落とし穴（必読）

- **別PC同期ハザード**: 本フォルダは別PCと同期。各フェーズ開始時に `git rev-parse HEAD` と `git status --short` を確認し、予期せぬ差分があれば停止してユーザー確認。commit は**パス限定 add**でWIPを巻き込まない。
- **stash 2件は触らない**（別PCのAcrobat演算子修復WIP・サイドカーWIP）。`git stash pop/apply/drop` 禁止。**特に stash@{0} は `stripStrayTextOperatorsOutsideTextObjects` の実装本体（pdfContentStream +146行・sweepNonDirtyPage 配線・pdfSaverCore）を含む＝feat/save-force-cleanup-toggle 所有。本ブランチで同関数を再実装しないこと**（保存パス二重実装の分岐回避）。`stripStrayTextOperators.test.ts` は本ブランチでは describe.skip 保留中。
- **`model: 'fable'` は現在利用不可**（Fable 5 unavailable）。レビュー隊は当面 **sonnet（finder）/ opus（判定）** で回す。メモリ `feedback_review_model_fable` の方針は復旧後に適用。
- **worktree では Playwright E2E が全スキップ**（No tests found）。worktreeループ内は MMP（unit+integration+cargo）まで、**E2EはPRのGitHub CI**に委ねる。
- **自動緑 ≠ 実機OK**: モックcanvasでピクセル/幾何は未検証。保存・座標の実体験は**実Acrobatの手動チェックでしか確定しない**＝P1クローズと#388のマージ前はHITL-3で実機確認。
- **ベースライン（健全・退行ハントの基準）**: `npm run test:critical` 119+1skip/135 緑、`cd apps/report-tool && npm test` 27ファイル498緑（修正後は501）。
- **Discovery の品質**: 16 NEW候補を「既定refute」で叩き12件却下・4件のみ通過。最初のP1候補（stripTextBlocks 未閉BT）も誤検知として却下済み（不正PDF限定・症状読み違い）。**同じ却下済み候補を蒸し返さない**（理由は発見記録に記載）。

---

## 6. 再開時の状態確認コマンド
```bash
cd /c/Users/user/Desktop/workspace20/pecotool_v2
git rev-parse --abbrev-ref HEAD && git rev-parse --short HEAD   # 期待: feature/report-tool-sidecar / 518a42b（変わっていれば要確認）
git status --short            # 6 fix files が M で残るか／WIPの有無
git stash list               # stash 2件が残るか
gh issue list --state open --search "PCT-158 PCT-159 PCT-160 in:title"
npm run test:critical        # 緑が基準
```

> 差分が消えている／HEADが違う場合は、別PCがコミット or stash を動かした可能性。コミット前に必ずユーザー確認。fix-round1 の差分は `git diff`（6ファイル）で再生成可能（修正内容は本書§1とコミットメッセージ参照）。
