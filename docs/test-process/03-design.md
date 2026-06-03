# PecoTool v2 テスト設計書

> Phase 3: テスト設計（How-to-Test 定義）
> 作成日: 2026-06-03
> 前提資料: `docs/test-process/02-analysis.md` / `docs/test-process/01-plan.md`
> 対象バージョン: v1.6.9 系（Tauri v2 + React 19 + zustand）

---

## 1. 目的

Phase 2 分析書（`02-analysis.md`）の「what-to-test」を「**how-to-test**」に展開する。
各モジュールに対してテスト技法を割り当て、テストレベル・粒度・命名規約を定義することで、
Phase 4 以降の実装者が迷いなく書けるテスト仕様を提供する。

### 入力

- `02-analysis.md` §2 テスト対象モジュール一覧（優先度付き）
- `02-analysis.md` §3 テスト観点マトリクス（横断観点）
- `02-analysis.md` §5.3 抜け漏れ判定（新規追加の優先候補）
- `01-plan.md` §3 リスク抽出（C-01〜C-05 / H-01〜H-07）

### 出力

本書で定義するもの:
1. 適用するテスト技法の選択基準
2. テストレベル設計（Unit / Integration / Component / E2E / 手動）
3. テストデータ設計方針
4. 優先度マトリクス（技法 × レベル）
5. テストの粒度ルール
6. テスト命名規約

---

## 2. 適用するテスト技法

### 2.1 同値分割 + 境界値分析

**対象モジュール**: pageIndex / zoom / radius / 配列長 / LRU キャッシュ長 / undoStack 上限

| 境界値候補 | 所在モジュール | テスト観点 |
| --- | --- | --- |
| `pageIndex = 0` / `pageIndex = pages.length - 1` | `pecoStore`, `usePageNavigation` | 先頭・末尾での操作が正しく処理される |
| `undoStack.length = 100` (上限) | `pecoStore` | 上限到達時に最古エントリが押し出される |
| `zoom = 0.1` (最小) / `zoom = 5.0` (最大) | `viewerStore` | 閾値でのクランプ動作 |
| `radius = 0` (curve) | `useCurveEditor` | 半径ゼロでの arc 出力が NaN/Infinity を生まない |
| `MAX_CACHED_PAGES` の前後 (LRU) | `pdfLoader`, `infraStore` | 退避・復元の境界でデータ保全 |
| `hitIndex = totalHits - 1` → 循環 | `searchStore` | prevSearchHit/nextSearchHit のラップアラウンド |
| 空配列 `blocks = []` | `ocrSort`, `bulkReorder` | 空入力で例外を投げない |
| 単要素配列 `blocks.length = 1` | `ocrSort` | ソート後に同一要素が返る |
| `groupTolerance = 0` | `ocrSort` | 全ブロックが別グループになる |

**技法のポイント**: 等価クラスを「正常域」「境界域」「エラー域」の 3 区分で設定し、
それぞれ 1 テストケースを原則とする。Infinity / NaN は常にエラー域として扱う。

---

### 2.2 デシジョンテーブル

**対象**: 保存パイプラインの条件分岐・モード・設定の組み合わせ爆発を制御する箇所

#### DT-01: `savePDF` の no-op / dirty 判定

| dirtyPages.length | LRU 退避済みページあり | 期待動作 |
| --- | --- | --- |
| 0 | なし | no-op short-circuit: 元バイト返却（byte equal） |
| 0 | あり | IDB からページを復元して通常保存 |
| 1+ | なし | 通常保存 |
| 1+ | あり | IDB 復元 + dirty ページ上書き保存 |

#### DT-02: `pdfPecoToolMetadata` 読み込み

| `/Catalog/PecoToolBBoxes` あり | `/Info/PecoToolBBoxes` あり (legacy) | 期待動作 |
| --- | --- | --- |
| あり | なし | catalog から読み込み |
| なし | あり | legacy fallback で読み込み |
| あり | あり | catalog 優先（legacy を無視） |
| なし | なし | 空メタ返却（例外なし） |

#### DT-03: `viewerStore` mode 排他

| drawing | split | curve | rangeOcr | 期待動作 |
| --- | --- | --- | --- | --- |
| true | false | false | false | 有効 |
| false | true | false | false | 有効 |
| false | false | true | false | 有効 |
| false | false | false | true | 有効 |
| true | true | * | * | 不正: 前の mode を自動解除 |

#### DT-04: save preset × dirty × meta 形態

| preset (compression on/off) | page dirty | meta あり | 期待動作 |
| --- | --- | --- | --- |
| off | no | any | no-op short-circuit |
| off | yes | catalog | 通常保存・metadata 維持 |
| off | yes | legacy | legacy 変換 + 通常保存 |
| on | no | any | no-op（圧縮非接続につきスキップ） |
| on | yes | any | 設計外（圧縮 UI 未接続: out of scope） |

---

### 2.3 状態遷移テスト

**対象**: mode 排他・Undo/Redo スタック・保存ライフサイクル・documentEpoch

#### ST-01: mode 排他状態機械（`viewerStore`）

```
初期: idle
idle → drawing: setDrawingMode(true)
idle → split:   setSplitMode(true)
idle → curve:   setCurveMode(true)
idle → rangeOcr: setRangeOcrMode(true)
drawing → idle: setDrawingMode(false) | resetViewerState()
drawing → split: setSplitMode(true) [drawing を自動解除]
...
任意モード → idle: resetViewerState()
```

検証すべき状態遷移:
- `drawing → split` で drawing が false になること
- `resetViewerState()` で全フラグがリセットされること
- 同一 mode を 2 回 set しても冪等であること

#### ST-02: Undo/Redo ライフサイクル（`pecoStore`）

```
初期: undoStack=[], redoStack=[]
操作 A: undoStack=[A], redoStack=[]
操作 B: undoStack=[A,B], redoStack=[]
undo:   undoStack=[A], redoStack=[B]
undo:   undoStack=[], redoStack=[A,B]
undo(空): no-op
redo:   undoStack=[A], redoStack=[B]
操作 C: undoStack=[A,C], redoStack=[] ← redo スタック消去
上限100操作後の101回目: 最古 A が押し出される
```

#### ST-03: 保存ライフサイクル（`useFileOperations`）

```
初期: isSaving=false, dirty=false
編集:  dirty=true
Ctrl+S: isSaving=true
保存完了: isSaving=false, dirty=false
Ctrl+S (dirty=false): no-op
```

#### ST-04: `documentEpoch` 単調増加（`infraStore`）

```
初期: documentEpoch=0
openDocument: documentEpoch++ (=1)
closeDocument: documentEpoch++ (=2)
OCR 開始: キャプチャした epoch で処理
openDocument (別ファイル): documentEpoch++ (=3)
OCR 完了チェック: キャプチャ epoch ≠ current epoch → キャンセル
```

---

### 2.4 ペアワイズ (Pairwise) テスト

**対象**: 複数パラメータの直積が大きく、全組み合わせが非現実的な箇所

#### PW-01: テキストブロック出力パラメータ

| パラメータ | 値候補 |
| --- | --- |
| writingMode | horizontal / vertical |
| curve あり | yes / no |
| rotation (page) | 0 / 90 / 180 / 270 |
| fontSubset あり | yes / no |

全組み合わせ: 2×2×4×2 = 32 → ペアワイズで 8〜10 ケースに削減

ツール: 手動設計（IPOG アルゴリズムに基づく）または `@fast-check/property` の組み合わせ生成を利用。

#### PW-02: OCR ソート設定

| パラメータ | 値候補 |
| --- | --- |
| writingMode | horizontal / vertical / mixed |
| groupTolerance | 0 / 5 / 20 |
| lowConfidenceThreshold | 0.0 / 0.5 / 1.0 |

全組み合わせ: 3×3×3 = 27 → ペアワイズで 9〜12 ケースに削減

---

### 2.5 異常系シナリオ

各モジュールに対して以下の異常入力を体系的に適用する。

| 異常入力カテゴリ | 具体例 | 期待動作 |
| --- | --- | --- |
| `null` / `undefined` | `document=null` での undo / `pageData=undefined` での save | no-op または明示的例外（データ破壊なし） |
| `Promise reject` | IDB write 失敗 / Tauri invoke 失敗 | エラー伝播・lastIdbError 更新 |
| race condition | 保存中のページ編集 / OCR 中のドキュメント切替 | epoch チェックでキャンセル / 最後書き勝ち防止 |
| 重複操作 | 同一ページへの 2 回保存 / 同一 BB の 2 回追加 | 冪等または明示的ガード |
| 空入力 | `blocks=[]` / `pages=[]` / `text=""` | 例外なし・空結果返却 |
| Infinity / NaN | `radius=Infinity` / `x=NaN` (bbox) | クランプまたは早期リジェクト |
| 壊れた PDF バイト | 不正 xref / truncated stream | 例外を catch してユーザーに通知 |
| 壊れた JSON | `proofreadingRules` の import / `pdfPecoToolMetadata` FlateDecode 後 | parse エラーを catch・空値 fallback |

---

### 2.6 回帰テスト

解決済み issue を固定テストとして維持する。テスト名に issue 番号を含め、再発を即検知する。

| issue # | 概要 | テスト種別 | 固定先ファイル |
| --- | --- | --- | --- |
| #100 | Acrobat dirty flag: no-op short-circuit | Integration | `pdfSaver.noOp.test.ts` |
| #101 | /ID 保持 | Integration | `pdfTrailerId.test.ts` |
| #188 | word-break trailing space in curve BT...ET | Integration | `pdfSaverCurveGlyph.test.ts` |
| #271 | viewer slice 分離後の mode 排他 | Unit | `viewerStore.test.ts` （新規）|
| #277 | Ribbon Alt アクセラレータ競合 | Component | `Ribbon.test.tsx` |

回帰テストは `describe('regression: issue#NNN', ...)` で囲み、skip 禁止とする。

---

### 2.7 冪等性 (Idempotency) テスト

**定義**: 同じ操作を 2 回以上繰り返しても結果が変わらないこと。

| 対象操作 | 検証方法 |
| --- | --- |
| `savePDF` (non-dirty) 2 回 | 出力バイト列が byte equal であること |
| `ensureDenseClassicXref` 2 回 | 出力 PDF が 1 回実行時と byte equal |
| `setDrawingMode(true)` 2 回 | state が `drawing=true` のまま変化なし |
| `addBlock` + `addBlock` (同一 ID) | 2 つ目が no-op またはエラー（重複なし） |

---

### 2.8 後方互換 (Backward Compatibility) テスト

旧バージョンで保存した PDF を現バージョンで正しく読み込み・保存できることを保証する。

| ケース | 読み込み元 | 検証内容 |
| --- | --- | --- |
| legacy bbox (`/Info/PecoToolBBoxes`) | PecoTool v1.x 保存 PDF | 読込後に catalog へ移行、メタデータ保全 |
| 非 PecoTool PDF | 任意 PDF | メタ不在でも crash なし・bbox 空で返却 |
| 旧 xref 形式 (classic, non-dense) | 旧ツール生成 PDF | `ensureDenseClassicXref` 後に Acrobat 互換 |
| catalog なし (古い PDF 仕様) | PDF 1.2 以前相当 | graceful degradation |

合成 PDF で再現可能な形で `src/__tests__/fixtures/` に格納する（機密 PDF は使用禁止）。

---

### 2.9 a11y テスト

**対象**: Ribbon / SaveDialog / DiffPreviewModal / OnboardingTour / OcrEditor

| 検証観点 | 技法 |
| --- | --- |
| `role` / `aria-*` 属性の正確性 | `@testing-library/jest-dom` の `toHaveRole` / `toHaveAttribute` |
| Tab 順序 | `userEvent.tab()` で要素が期待順にフォーカスされること |
| Esc でモーダルが閉じる | `userEvent.keyboard('{Escape}')` |
| フォーカストラップ | モーダル内で Tab が外に出ないこと |
| Alt アクセラレータ | `userEvent.keyboard('{Alt>}1{/Alt}')` でタブ切替 |

---

### 2.10 性能テスト

**対象**: 大規模 PDF / 大量 BB

| シナリオ | 閾値 | 計測方法 |
| --- | --- | --- |
| 1000 ページ PDF 初期表示 | 3000ms 以内 | `performance.now()` で計測、`expect(elapsed).toBeLessThan(3000)` |
| 1000 ページ目へのページ遷移 | 200ms 以内 | 同上 |
| 5000 BB 描画（overlay render） | フレーム落ちなし（60fps 基準） | `requestAnimationFrame` コールバック時間計測 |
| `pdfSizeRegression`: 保存 PDF サイズ | 元ファイルサイズ ×1.5 未満 | バイト数比較 |

---

## 3. テストレベル設計

### 3.1 Unit (vitest + jsdom + mock)

**対象**: pure function / store action / hook / 個別 util

**技法の組み合わせ**:
- 同値分割 + 境界値分析（必須）
- 異常系シナリオ（必須）
- 状態遷移（store action のみ）
- 冪等性（該当 function のみ）

**実行コマンド**: `npm run test`（unit に含まれる）

**対象ファイルパターン**: `src/__tests__/unit/*.test.ts`

**新規優先追加対象**（Phase 2 §5.3 抜け漏れから）:

| モジュール | テストファイル（新規） | 主な技法 |
| --- | --- | --- |
| `infraStore` | `infraStore.test.ts` | 状態遷移 (documentEpoch) + 境界値 (LRU) + 異常系 (race) |
| `viewerStore` | `viewerStore.test.ts` | デシジョンテーブル (mode 排他) + 状態遷移 + 冪等性 |
| `searchStore` | `searchStore.test.ts` | 境界値 (循環: totalHits=0 / 末尾→先頭) + 同値分割 |
| `usePageManagement` | `usePageManagement.test.ts` | 異常系 (引数バリデーション) + 状態遷移 |
| `useBackupManagement` | `useBackupManagement.test.ts` | 異常系 (復元競合) + race simulation |
| `pdfFastMetadata` | `pdfFastMetadata.test.ts` | 同値分割 + 異常系 (decode 失敗) |
| `pdfLibSafeDecode` | `pdfLibSafeDecode.test.ts` | 異常系 (壊れた stream) + 境界値 |
| `pdfPecoToolMarkers` | `pdfPecoToolMarkers.test.ts` | 同値分割 + 後方互換 |
| `pdfVersion` | `pdfVersion.test.ts` | 同値分割 + 境界値 |
| `ocrEditFlush` | `ocrEditFlush.test.ts` | 状態遷移 + race simulation (flush 中 document 切替) |

---

### 3.2 Integration (vitest + jsdom + real pdf-lib)

**対象**: pdfSaver / pdfReachabilityGc / pdfPecoToolMetadata / handleSave 等のクロスモジュール操作

**技法の組み合わせ**:
- デシジョンテーブル（保存条件分岐）
- 後方互換（legacy meta / classic xref）
- 冪等性（2 回保存 byte equal）
- race condition（保存中編集）

**実行コマンド**: `npm run test`（integration に含まれる）

**対象ファイルパターン**: `src/__tests__/integration/*.test.ts`

**新規優先追加対象**:

| シナリオ | テストファイル（新規） | 主な技法 |
| --- | --- | --- |
| race 観点集約 | `raceConditions.integration.test.ts` | race simulation: OCR 中 close / DnD 中編集 / IDB 中 reload |
| 後方互換マトリクス横断 | `backwardCompat.integration.test.ts` | 後方互換: legacy bbox / 旧 xref / 非 PecoTool PDF 横断 |
| 大規模 1000 ページ | `loadTest1000Pages.test.ts` | 性能: LRU 退避が効く規模で保存 + 復元 |
| `useBackupManagement` 復元競合 | `backupRestore.integration.test.ts` | race simulation: 保存中の復元 |

---

### 3.3 Component (vitest + jsdom + @testing-library/react)

**対象**: PdfCanvas / OcrEditor / Ribbon / OnboardingTour / SaveDialog / DiffPreviewModal

**技法の組み合わせ**:
- 状態遷移（UI モード遷移）
- a11y（role / Tab / Esc / フォーカストラップ）
- 回帰（issue#277 Alt アクセラレータ）

**実行コマンド**: `npm run test`（components に含まれる）

**対象ファイルパターン**: `src/__tests__/components/*.test.tsx`

**新規優先追加対象**:

| コンポーネント | 観点 | 主な技法 |
| --- | --- | --- |
| `Ribbon` (issue#277) | Alt アクセラレータ競合 | 回帰 + a11y |
| `SaveDialog` | a11y フォーカストラップ | a11y |
| `DiffPreviewModal` | モーダル開閉 Esc | a11y + 状態遷移 |

---

### 3.4 E2E (Playwright + Tauri mock)

**対象**: ユーザー journey ベースの通しシナリオ

**技法**: ユーザー journey ベース

**実行コマンド**: `npm run test:e2e:ci`

**対象ファイルパターン**: `src/__tests__/e2e/*.spec.ts`

**設計方針**:
- 1 シナリオ = 1 ユーザーゴール（「PDF を開いて編集して保存する」等）
- E2E は UI の結合動作確認に限定、ロジック検証は Unit/Integration に委ねる
- Tauri `invoke` は mock で差し替え

**重点シナリオ**:

| ID | シナリオ | 含む操作 |
| --- | --- | --- |
| E-UI-01 | 基本保存フロー | 開く → テキスト編集 → Ctrl+S → 完了確認 |
| E-UI-02 | 別名保存フロー | 開く → 編集 → Ctrl+Shift+S → ダイアログ → 保存 |
| E-UI-03 | Ribbon モード切替 | タブ切替 → drawing → split → curve → 各操作 |
| E-UI-04 | OCR → 編集 → 保存 | OCR 実行 → テキスト修正 → 保存 |
| E-UI-05 | Undo/Redo round-trip | 編集 → Undo × 3 → Redo × 3 → 保存 |

---

### 3.5 手動テスト (Acrobat 実機 / 高解像度 / 大規模 PDF)

**対象**: 自動化が困難な Tier 3 項目（`01-plan.md` §4 参照）

| 項目 | 判定基準 | 担当 |
| --- | --- | --- |
| Acrobat dirty flag 確認 | 保存後に Acrobat の「保存しますか？」が出ない | ユーザー |
| Acrobat 7.0 BT...ET 目視確認 | 文字化け・構造エラーなし | ユーザー |
| 1000 ページ実機操作 | 3 秒以内初期表示・200ms 以内ページ遷移 | ユーザー |
| 高解像度 (4K) Canvas 描画崩れ確認 | overlay がページ境界に正しく重なる | ユーザー |
| バックアップ復元ダイアログ | クラッシュ後リスタートで復元ダイアログが出る | ユーザー |

手動確認チェックリストは Phase 6 (`06-manual-checklist.md`) で詳細化する。

---

## 4. テストデータ設計

### 4.1 合成 PDF（pdf-lib で生成）

CI で使用可能な合成 PDF を `src/__tests__/fixtures/synthetic/` に配置する。
機密 PDF は絶対にコミットしない（`MEMORY.md` 参照）。

| fixture 名 | 用途 | 生成方法 |
| --- | --- | --- |
| `single-page.pdf` | 基本 Unit テスト | pdf-lib で 1 ページ生成 |
| `multi-page-10.pdf` | ページ操作テスト | 10 ページ生成 |
| `multi-page-100.pdf` | LRU テスト | 100 ページ生成 |
| `legacy-meta.pdf` | 後方互換テスト | `/Info/PecoToolBBoxes` を手動挿入 |
| `classic-xref.pdf` | xref テスト | dense xref 変換前の classic xref 形式 |
| `no-pecotool-meta.pdf` | 非 PecoTool PDF | 通常 PDF（メタなし） |
| `curve-glyph.pdf` | curve 出力テスト | BT...ET ブロック含む合成 PDF |
| `rotated-pages.pdf` | rotation テスト | 90/180/270 度回転ページ混在 |
| `encrypted.pdf` | 暗号化検出テスト | pdf-lib の encrypt API を使用 |

### 4.2 mock / stub データ

| 対象 | 方式 | 場所 |
| --- | --- | --- |
| Tauri `invoke` | `vi.mock('@tauri-apps/api/core')` | 各テストファイル or `setup.ts` |
| pdfjs Worker | `vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', ...)` | `vitest.setup.ts` |
| Canvas 2D Context | `minimal stub` | `src/__tests__/setup.ts` |
| IndexedDB | `fake-indexeddb` | `vitest.setup.ts` / テスト内 `beforeEach` |
| Tauri updater | `src/__tests__/__stubs__/tauri-plugin-updater.ts` | stub ファイル |
| `document.createElement` (pdfjs Worker) | polyfill | `thumbnail.worker.ts` の先頭で注入（実装側対応） |

### 4.3 Tauri mock の標準実装パターン

```ts
// テストファイル冒頭でのスタブ定義（パターン例）
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case 'write_file_atomically': return null;
      case 'read_file_safe': return new Uint8Array([37, 80, 68, 70]); // %PDF
      case 'check_pending_backups': return [];
      default: throw new Error(`unhandled Tauri command: ${cmd}`);
    }
  }),
}));
```

---

## 5. テストケースの優先度マトリクス

| 優先度 | Unit | Integration | Component | E2E | 手動 |
| --- | --- | --- | --- | --- | --- |
| **Critical** | 必須（重複 OK） | 必須（重複 OK） | 必須 | 必須 | 不要（自動で代替） |
| **High** | 必須 | 必須 | 推奨 | 推奨 | リスクに応じて |
| **Medium** | 必須 | 推奨 | 望ましい | — | リスクに応じて |
| **Low** | 推奨 | — | — | — | チェックリストに追記 |

### 対象モジュール別マッピング（抜粋）

| モジュール | 優先度 | Unit | Integration | Component | E2E |
| --- | --- | --- | --- | --- | --- |
| `pdfSaver` | Critical | 必須 | 必須 | — | 必須 |
| `pecoStore` | Critical | 必須 | 必須 | — | 必須 |
| `infraStore` | High | **必須（新規）** | — | — | — |
| `useOcrEngine` | High | 必須 | 必須 | — | 推奨 |
| `pdfLoader` | High | 必須 | — | — | 推奨 |
| `tauriFileIO` | High | 必須 | — | — | — |
| `viewerStore` | Medium | **必須（新規）** | — | — | — |
| `PdfCanvas` | High | 必須 | — | — | — |
| `Ribbon` | Medium | — | — | 必須 | — |
| `searchStore` | Low | **推奨（新規）** | — | — | — |
| `OnboardingTour` | Low | — | — | 推奨 | — |

---

## 6. テストの粒度ルール

### 6.1 1 it = 1 assertion 原則

- 1 つの `it` / `test` ブロックには原則 1 つのアサーションを置く
- 複数アサーションが必要な場合は `describe` で意図を分けて複数 `it` に分割する
- 例外: `toEqual` で複合オブジェクトを検証する場合は 1 アサーションで複数プロパティを確認可

```ts
// 良い例
it('should set drawing mode to true', () => {
  store.setDrawingMode(true);
  expect(store.isDrawing).toBe(true);
});

it('should clear split mode when drawing mode is set', () => {
  store.setSplitMode(true);
  store.setDrawingMode(true);
  expect(store.isSplit).toBe(false);
});

// 悪い例（2 つの観点が混在）
it('should set drawing mode and clear split mode', () => {
  store.setSplitMode(true);
  store.setDrawingMode(true);
  expect(store.isDrawing).toBe(true);  // assertion 1
  expect(store.isSplit).toBe(false);   // assertion 2 ← 別 it に分割すべき
});
```

### 6.2 describe の粒度

- `describe` = 機能単位（モジュール or 関数）
- ネストの `describe` = 観点単位（正常系 / 異常系 / 境界値）
- `it` = 単一シナリオ

```ts
describe('viewerStore', () => {
  describe('mode exclusivity', () => {
    it('U-VS-01: should set drawing mode', ...)
    it('U-VS-02: should clear split mode when drawing mode is set', ...)
  });
  describe('resetViewerState', () => {
    it('U-VS-10: should reset all mode flags to false', ...)
  });
});
```

### 6.3 mock の使用方針

- `vi.mock` は外部依存（Tauri / IDB / pdfjs Worker）にのみ使用
- 内部モジュール間は可能な限り実 import を使う（Integration テストでは real pdf-lib 推奨）
- `vi.spyOn` は副作用の確認（呼ばれたかどうか）にのみ使用し、実装の置き換えには使わない
- mock のリセットは `afterEach(() => vi.clearAllMocks())` で統一

---

## 7. テスト命名規約

### 7.1 テストファイル命名

```
Unit:        src/__tests__/unit/<camelCaseName>.test.ts
Integration: src/__tests__/integration/<camelCaseName>.integration.test.ts
Component:   src/__tests__/components/<ComponentName>.test.tsx
E2E:         src/__tests__/e2e/<scenarioName>.spec.ts
```

### 7.2 テストケース ID 体系

```
U-XX-NN   Unit テスト
I-XX-NN   Integration テスト
C-XX-NN   Component テスト
E-XX-NN   E2E テスト
```

- `XX`: モジュール略号（下表参照）
- `NN`: 2 桁連番（01〜99）

### 7.3 モジュール略号一覧

| 略号 | モジュール |
| --- | --- |
| PS | pdfSaver |
| PM | pdfPecoToolMetadata |
| PT | pdfTrailerId |
| PL | pdfLoader |
| PG | pdfReachabilityGc |
| PX | pdfClassicXref |
| PC | pdfCurveTextRender |
| PE | pdfPageExtractor |
| TS | pdfTemporaryStorage |
| TF | tauriFileIO |
| IS | infraStore |
| VS | viewerStore |
| SS | searchStore |
| PO | pecoStore |
| OE | useOcrEngine |
| OS | ocrSort |
| BJ | useBatchJob |
| BD | useBlockDragResize |
| CE | useCurveEditor |
| CD | useCanvasDrawing |
| FR | useFindReplace |
| BR | bulkReorder |
| PM2 | usePageManagement |
| BK | useBackupManagement |
| CV | PdfCanvas |
| RB | Ribbon |
| SD | SaveDialog |
| OT | OnboardingTour |
| OA | OcrEditor |
| UI | E2E 全般 |

### 7.4 it ブロック命名パターン

```ts
it('U-IS-01: should increment documentEpoch on openDocument', ...)
it('U-IS-02: should cancel OCR when documentEpoch changes during processing', ...)
it('U-VS-01: should set drawing mode exclusively', ...)
it('I-PS-01: should return original bytes when no dirty pages (byte equal)', ...)
it('C-RB-01: should activate Alt+1 accelerator to switch first tab', ...)
it('E-UI-01: should complete basic save flow from open to Ctrl+S', ...)
```

### 7.5 回帰テスト命名

```ts
describe('regression: issue#188', () => {
  it('should close BT...ET block for each curve glyph (word-break fix)', ...)
});
```

---

## 8. 未解決事項・次フェーズへの引き継ぎ

| 項目 | 内容 | 引き継ぎ先 |
| --- | --- | --- |
| `searchStore` テストの実体確認 | `searchHitNavigation.test.ts` が store 直接テストかナビゲーション結合かを要確認 | Phase 4 実装者 |
| ペアワイズ生成ツールの選定 | `@fast-check/property` の採用可否を architect と合意 | Phase 4 実装前に判断 |
| 1000 ページ合成 PDF の生成コスト | ビルド時間への影響を計測してから fixture に含めるか判断 | Phase 4 実装者 |
| `ocrEditFlush` の実装確認 | flush ロジックの所在（フック内か store か）を確認してから設計を確定 | Phase 4 実装者 |
| Tauri sidecar クラッシュ再現 | Worker null 注入で代替できるか実験 | Phase 4 実装者（integration） |

---

*このドキュメントは Phase 3 成果物。Phase 4 でテストコードを実装する。*
