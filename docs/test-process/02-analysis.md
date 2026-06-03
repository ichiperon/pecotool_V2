# PecoTool v2 テスト分析書

> Phase 2: テスト分析（What-to-Test 導出）
> 作成日: 2026-06-03
> 前提資料: `docs/TEST_REQUIREMENTS.md` / `CLAUDE.md`（global）/ `README.md` / `src/` 構造
> 対象バージョン: v1.6.9 系（Tauri v2 + React 19 + zustand）

---

## 1. 目的

本書は spec（README / 既存 docs / `src/` の実装構造）から「**何をテストするべきか (what-to-test)**」を導出し、モジュール単位で優先度を付与する。実装の詳細手順 (how-to-test) は Phase 3 以降で扱う。

### 1.1 優先度定義

| 優先度 | 定義 | 判定基準 |
| --- | --- | --- |
| **Critical** | 壊れるとデータ破壊・保存事故に直結 | 保存パイプライン / 編集状態の正本 |
| **High** | 壊れると主要ワークフローが停止 | OCR / 読込 / メタ保持 / 編集操作 |
| **Medium** | 壊れると一部機能が劣化 | 補助機能 / UI / 描画 |
| **Low** | 壊れても代替手段あり / 影響軽微 | 設定 / 検索 / ツアー |

### 1.2 優先度の根拠ロジック

PecoTool の中核価値は「既存 PDF を**壊さずに**上書き保存する」点にある（README「PDF 上書き保存」）。
したがって優先度は **保存パイプラインの正本性 > 編集状態の正本性 > OCR/読込 > UI** の順で重み付けする。

---

## 2. テスト対象モジュール一覧

全 20 モジュール（＋関連サブモジュールを観点に集約）。`既存` 列は対応する直接テストファイルの有無を示す。

### 2.1 Core: PDF 保存 / 読み込み

| モジュール | 機能 | テスト観点 | 優先度 | 既存 |
| --- | --- | --- | --- | --- |
| `pdfSaver` | 保存パイプライン (`buildPdfDocument` / `savePDF`) | 通常 / no-op (非 dirty short-circuit) / dirty / curve / rotation / compression / Worker 経由 / fallback font | **Critical** | あり (unit + 多数 integration) |
| `pdfSaverCore` | 共通低レベル関数 | `decodeStreamContents` / `bytesEqual` / `cleanContentStream` / `collectPageContentRefCounts` / `isFormXObject` / `deleteIfUniqueRef` | **High** | あり (unit) |
| `pdfTrailerId` | `/ID` 保持 (`extractTrailerId` / `overwriteTrailerId`) | extract / overwrite / hex 長 mismatch / `/ID` 不在 / 16進パース失敗 | **High** | あり (unit + integration) |
| `pdfPecoToolMetadata` | bbox メタ read/write | read / write / legacy fallback (`removeLegacyPecoToolBBoxInfo`) / FlateDecode 失敗 / round-trip | **High** | あり (unit + integration) |
| `pdfReachabilityGc` | sweep / compact | `sweepUnreachableObjects` (reachable / orphan) / `compactIndirectObjectNumbers` / dense check | **Medium** | あり (integration ×2) |
| `pdfClassicXref` | classic xref 形式 (`ensureDenseClassicXref`) | dense xref 変換 / trailer 保持 / 既に dense な入力の冪等性 | **Medium** | あり (unit) |
| `pdfCurveTextRender` | curve PDF 出力 | `buildCurveGlyphOperators` (arc / polyline) / `buildPageRotationCm` / per-glyph Tm | **Medium** | あり (unit + integration) |
| `pdfPageExtractor` | ページ抽出 | `extractPagesToNewPdf` (range / metadata 維持) / `isPdfEncrypted` (暗号化検出) | **Medium** | あり (unit) |
| `pdfLoader` | 読込 + LRU proxy キャッシュ | LRU page proxy / shared PDF proxy / writing-mode 検出 / fallback 計算 / IDB / `waitForPendingIdbSaves` | **High** | あり (unit) |
| `pdfTemporaryStorage` | IDB 永続化 | get/save (batch) / clear / rename keys / delete keys / cached page round-trip / 容量境界 | **High** | あり (unit ×2 + integration) |
| `tauriFileIO` | ファイル I/O | `writeFileChunked` / `writeFileAtomically` / `readFileSafe` / `isWriteAccessError` 判定 | **High** | あり (unit) |

### 2.2 Core: OCR

| モジュール | 機能 | テスト観点 | 優先度 | 既存 |
| --- | --- | --- | --- | --- |
| `useOcrEngine` | OCR 実行 | current / all / folder / range / text-layer detection / epoch によるキャンセル / sidecar 呼び出し mock | **High** | あり (unit + integration) |
| `ocrSort` | 読み順ソート | sortHorizontal / sortVertical / groupByTolerance / mixed mode / 空入力 | **High** | あり (unit) |
| `useBatchJob` | 一括ジョブ | 進捗 / 中断 / フォルダ走査 / 失敗ファイルスキップ | **Medium** | あり (unit) |

### 2.3 Editor

| モジュール | 機能 | テスト観点 | 優先度 | 既存 |
| --- | --- | --- | --- | --- |
| `useBlockDragResize` | BB 操作 | drag / resize / multi-select 移動 / undo 記録 / scale 補正 | **High** | あり (unit) |
| `useCurveEditor` | 湾曲編集 | arc 3 点 (`arcFromThreePoints`) / polyline / handle drag / viewport 座標変換 | **Medium** | あり (unit) |
| `useCanvasDrawing` | 描画モード | rectangle 描画 / split / 最小サイズ閾値 / mode 排他 | **Medium** | あり (unit) |
| `useFindReplace` | 検索置換 | `buildRegexOrError` (正規表現エラー) / `countMatches` / skip-editing / 全置換 | **Medium** | あり (unit + integration) |
| `bulkReorder` | 一括並べ替え | `classifyDirection` / `reorderBlocks` / `getDirectionLabel` / 閾値 (`reorderThreshold`) | **Medium** | あり (unit) |
| `proofreadingRules` | 校正ルール | load/save/export/import/validate (壊れた JSON) / `createRule` | **Low** | あり (unit) |

### 2.4 State (store)

| モジュール | 機能 | テスト観点 | 優先度 | 既存 |
| --- | --- | --- | --- | --- |
| `pecoStore` | document / edit / undo の正本 | undo/redo (上限100) / `updatePageData` (LRU 退避) / `deletePages` / `movePage` / `rotatePages` / selection / clipboard / dirty 管理 | **Critical** | あり (unit) |
| `infraStore` | インフラ層 | `documentEpoch` 単調増加 / `pageAccessOrder` LRU / `pendingRestoration` / `currentPageProxy` 共有 + expectedKey race / `lastIdbError` | **High** | **なし** |
| `viewerStore` | viewer UI 状態 | zoom / `ocrOpacity` / mode 排他 (drawing / split / curve / rangeOcr) / `resetViewerState` | **Medium** | **なし** |
| `searchStore` | 検索状態 | `setSearchTerm` (hitIndex リセット) / `nextSearchHit` / `prevSearchHit` (循環境界) | **Low** | **なし** |
| `ocrSettingsStore` | OCR/ソート設定 | row/column/mixed order / `groupTolerance` / 信頼度閾値 / low-confidence ハイライト | **Low** | あり (unit) |

### 2.5 UI (component)

| モジュール | 機能 | テスト観点 | 優先度 | 既存 |
| --- | --- | --- | --- | --- |
| `PdfCanvas` | PDF + overlay 描画 | overlay layers / curve 描画 / confidence ハイライト / static layer 分離 / pan / zoom | **High** | あり (unit ×2) |
| `OcrEditor` | OCR カード編集 | search filter / DnD 並べ替え / Ctrl+Arrow / カード commit | **Medium** | あり (component) |
| `Ribbon` | リボン UI | tab 切替 / button 配置 / ResizeObserver 折り畳み / Alt アクセラレータ / a11y | **Medium** | あり (component) |
| `SaveDialog` / `DiffPreviewModal` | 保存 / 差分プレビュー | 圧縮トグル / 別名保存 / `computeSaveDiff` 表示 / モーダル a11y | **Medium** | あり (unit + component) |
| `OnboardingTour` | 初回ツアー | 4-mask / step 遷移 / localStorage 既読フラグ / スキップ | **Low** | あり (component) |

---

## 3. テスト観点マトリクス（横展開）

優先度を縦軸モジュールに、観点を横軸に展開する。`◎` = 必須 / `○` = 推奨 / `−` = 対象外。

| 観点 | 代表的な適用モジュール / 具体例 |
| --- | --- |
| **正常系** | ◎ 全モジュール |
| **非正常系 (null/undefined/エラー)** | ◎ 全モジュール。例: `document=null` 時の undo no-op / 壊れた JSON ルール / FlateDecode 失敗 / `/ID` 不在 |
| **境界値** | bbox.x=0 / pageIndex=last / undoStack 上限 100 / radius=0 (curve) / LRU `MAX_CACHED_PAGES` / hitIndex 循環 / 0 ページ PDF |
| **並行操作 (race)** | ◎ `saveDuringEditRace` / OCR 中の close (`documentEpoch` キャンセル) / `currentPageProxy` の file-switch race / DnD 中のテキスト編集 / IDB 保存中の reload |
| **Undo/Redo 不変条件** | ◎ 全 dirty 操作 (`updatePageData` / `deletePages` / `movePage` / `rotatePages` / BB drag/resize)。round-trip でデータ保全 |
| **後方互換 (旧保存 PDF 読込)** | `pdfSaver` / `pdfPecoToolMetadata` (legacy bbox info fallback) / 旧バージョン catalog / 非 PecoTool PDF |
| **データ保全 (save→reload round-trip)** | ◎ `saveReloadRoundtrip` / `curveBBoxMetaRoundtrip` / メタ・rotation・curve の往復一致 |
| **Acrobat 互換** | `pdfSaver` (word-break / classic xref / `/ID` 保持) — 実機検証は手動、構造検証は自動 |
| **パフォーマンス / スケール** | 1000 ページ (LRU) / 500 ページ load (`loadTest500Pages`) / 5000 BB / `pdfSizeRegression` (出力肥大防止) |
| **a11y** | 全 UI (Ribbon / モーダル / SaveDialog)。`ModalsA11y` 既存。フォーカストラップ / role / キーボード操作 |
| **冪等性** | `ensureDenseClassicXref` / 非 dirty save の short-circuit (バイト不変) |

---

## 4. テスト未対象 (Out of Scope) と理由

| 対象 | 扱い | 理由 |
| --- | --- | --- |
| Tauri sidecar 実バイナリ (OCR エンジン / Updater) | mock のみ | 実バイナリは CI 非搭載。`@tauri-apps/api/*` は `vi.mock`、Updater は `__stubs__/tauri-plugin-updater` でスタブ |
| Acrobat / 各種ビューア実機での開封確認 | 手動 | レンダラ依存・自動化困難。構造正当性 (xref / `/ID` / word-break) のみ自動化 |
| macOS / Linux ビルド | 対象外 | README 記載の通り Windows 10/11 専用ビルド |
| 実 PDF フィクスチャ (機密) | コミット禁止 | 機密 PDF は `/test/` 配下にあってもコミット不可（プロジェクト制約）。CI では合成 PDF を使用 |
| Rust バックエンド (Tauri command) 単体 | 別管轄 | 本書は TS フロント層が対象。Rust 側テストは別フローで管理 |
| ネットワーク / 自動更新の実通信 | mock のみ | `useAppUpdater` は stub 経由でロジックのみ検証 |

---

## 5. 既存テストカバレッジサマリ

### 5.1 規模（実測 / 2026-06-03 時点）

| レイヤー | テストファイル数 | テストケース数 (it/test) |
| --- | --- | --- |
| unit (`src/__tests__/unit/`) | 72 | — |
| component (`src/__tests__/components/`) | 12 | — |
| integration (`src/__tests__/integration/`) | 39 | — |
| **小計 (Vitest)** | **123** | **約 1735** |
| e2e (`src/__tests__/e2e/`, Playwright) | 10 | **52** |

> `TEST_REQUIREMENTS.md` 策定時 (2026-04-16) の目標は Vitest 250 / E2E 20 だったが、実装はそれを大きく上回り Vitest ≈1735 / E2E 52 に到達済み。

### 5.2 厚くカバーされている領域（過剰なほど）

- **保存パイプライン**: `pdfSaver` 系 integration が 20 本超（Acrobat 互換 / 圧縮 / curve glyph / font dedup / shared FormXObject / rotation / `/ID` 保持 / multi-stream decode failure 等）。Critical 領域として妥当。
- **実 PDF シナリオ**: `realPdf*Scenarios` 系で durability / variant / structural / mutation / micro-shift を網羅。
- **round-trip**: save→reload / curve bbox meta / undo-redo の往復検証あり。

### 5.3 抜け漏れ判定（現状 vitest/e2e で未カバーの観点）

| 抜け | 内容 | 推奨優先度 |
| --- | --- | --- |
| **`infraStore` 直接テスト無し** | `documentEpoch` 単調増加 / `currentPageProxy` の expectedKey race 防止 / `pageAccessOrder` LRU が単体未検証。#102/#118 の race 防止ロジックがここに集約されているのに穴。**High 領域の単体欠落**。 | High |
| **`viewerStore` 直接テスト無し** | #271 で分離されたばかり。mode 排他 (drawing/split/curve/rangeOcr の相互排他) と `resetViewerState` が単体未検証。 | Medium |
| **`searchStore` 直接テスト無し** | `nextSearchHit`/`prevSearchHit` の循環境界 (totalHits=0、末尾→先頭) が未検証。`searchHitNavigation.test.ts` は存在するが store 直接ではなくナビゲーション結合の可能性 → **要確認**。 | Low |
| **`usePageManagement` / `usePageExtraction` フック未カバー** | delete/move のハンドラ層が単体テスト無し（`pecoStore` 側 action は有り）。フックの引数バリデーション・エラー伝播が穴。 | Medium |
| **`useBackupManagement` 未カバー** | バックアップ復元のハンドラ層が単体テスト無し。`useAutoBackup` は有り。復元時の競合 (保存中の復元) が穴。 | Medium |
| **`pdfFastMetadata` / `pdfLibSafeDecode` / `pdfPecoToolMarkers` / `pdfVersion` 未カバー** | 低レベル PDF ヘルパに直接テスト無し（間接的には integration で踏まれている可能性大）。decode 失敗系のエラーパスが単体未保証。 | Medium |
| **`ocrEditFlush` 未カバー** | OCR 編集の flush ロジック単体テスト無し。flush 中の document 切替 race が穴。 | Medium |
| **race 系の体系化不足** | `saveDuringEditRace` は有るが、`OCR 中 close` / `DnD 中編集` / `IDB 保存中 reload` の race が個別散在。**並行操作の観点を集約した一覧が無い**。 | High |
| **大規模スケール (1000 ページ / 5000 BB)** | `loadTest500Pages` はあるが 1000 ページ (LRU 退避が効く規模) と 5000 BB 描画の負荷テストが未到達。 | Medium |
| **後方互換マトリクスの体系化** | legacy bbox / 非 PecoTool PDF / 旧バージョン catalog は個別にあるが、「読込→保存で旧情報を壊さない」横断観点としては未集約。 | Medium |

### 5.4 総括

- **Critical 領域 (pdfSaver / pecoStore) は十分以上にカバー済み**。データ破壊リスクは現状テストで高く防御されている。
- **最大の穴は新設 store 群 (infraStore / viewerStore / searchStore) の単体欠落**。特に `infraStore` は race 防止の心臓部であり、High として最優先で単体テストを追加すべき。
- **次点はハンドラ層フック (usePageManagement / usePageExtraction / useBackupManagement) と低レベル PDF ヘルパ**のエラーパス。
- **横断観点 (race / 後方互換 / 大規模スケール)** は個別テストは散在するが「観点として集約された保証」が無い。Phase 3 で観点ドリブンに再編成する価値がある。
