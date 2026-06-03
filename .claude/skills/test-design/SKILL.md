---
name: test-design
description: Phase 2 テスト分析を入力に、適用するテスト技法と pattern を体系的に設計する
metadata:
  type: process
  phase: 3
  author: tester_unit (百鬼あやめ)
  created: 2026-06-03
  based_on: docs/test-process/03-design.md
---

# Test Design Skill

## 用途

PecoTool 等のアプリで、テスト分析 (what-to-test) を「どのようにテストするか」の設計に変換する。
テスト技法を各モジュールに割り当て、テストレベル・粒度・命名規約を定義する。

## 前提

- `docs/test-process/02-analysis.md`（Phase 2 成果物）が存在すること
- `docs/test-process/01-plan.md`（Phase 1 成果物）も併読推奨
- テストフレームワーク: Vitest + jsdom / @testing-library/react / Playwright

## 実行手順

### Step 1: 分析書の読み込み

```
Read: docs/test-process/02-analysis.md
  - §2 テスト対象モジュール一覧（優先度付き）
  - §3 テスト観点マトリクス（横断観点）
  - §5.3 抜け漏れ判定（新規追加の優先候補）
```

### Step 2: テスト技法の選択

以下の判断基準に従い、各モジュールに技法を割り当てる。

| 状況 | 適用する技法 |
| --- | --- |
| 数値パラメータが境界を持つ | 同値分割 + 境界値分析 |
| 条件の組み合わせが複数ある | デシジョンテーブル |
| UI モード / undo-redo など状態がある | 状態遷移テスト |
| 複数パラメータの直積が大きい | ペアワイズ (Pairwise) |
| null / undefined / Promise reject などのエラー経路 | 異常系シナリオ |
| 解決済み issue の再発防止 | 回帰テスト（describe に issue# を含める） |
| 同一操作を 2 回で変化なし | 冪等性テスト |
| 旧バージョンの成果物を読み込む | 後方互換テスト |
| role / aria / Tab / Esc など UI 操作 | a11y テスト |
| ページ数 / BB 数 / レスポンス時間 | 性能テスト |

### Step 3: テストレベルの振り分け

以下のルールでレベルを決定する。

| テストレベル | 対象 | フレームワーク |
| --- | --- | --- |
| Unit | pure function / store action / hook / util | Vitest + jsdom + vi.mock |
| Integration | クロスモジュール / pdf-lib を実際に使う操作 | Vitest + jsdom + real pdf-lib |
| Component | React コンポーネント / UI 操作 | Vitest + @testing-library/react |
| E2E | ユーザー journey 通しシナリオ | Playwright + Tauri mock |
| 手動 | Acrobat 実機 / 実 PDF / 大規模操作 | チェックリスト（Phase 6） |

優先度 × レベルのマトリクス:

| 優先度 | Unit | Integration | Component | E2E |
| --- | --- | --- | --- | --- |
| Critical | 必須 | 必須 | 必須 | 必須 |
| High | 必須 | 必須 | 推奨 | 推奨 |
| Medium | 必須 | 推奨 | 望ましい | — |
| Low | 推奨 | — | — | — |

### Step 4: テストデータ設計

- **合成 PDF**: `pdf-lib` で生成。機密 PDF は絶対にコミット禁止
- **fixture 配置**: `src/__tests__/fixtures/synthetic/`
- **mock**: Tauri API は `vi.mock`、IDB は `fake-indexeddb`

Tauri mock 標準パターン:

```ts
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case 'write_file_atomically': return null;
      case 'read_file_safe': return new Uint8Array([37, 80, 68, 70]); // %PDF
      default: throw new Error(`unhandled Tauri command: ${cmd}`);
    }
  }),
}));
```

### Step 5: 命名規約の適用

テストケース ID 体系:

```
U-XX-NN   Unit テスト      (src/__tests__/unit/*.test.ts)
I-XX-NN   Integration テスト (src/__tests__/integration/*.integration.test.ts)
C-XX-NN   Component テスト  (src/__tests__/components/*.test.tsx)
E-XX-NN   E2E テスト        (src/__tests__/e2e/*.spec.ts)
```

it ブロック命名例:

```ts
it('U-IS-01: should increment documentEpoch on openDocument', ...)
it('I-PS-01: should return original bytes when no dirty pages (byte equal)', ...)
it('C-RB-01: should activate Alt+1 accelerator to switch first tab', ...)
it('E-UI-01: should complete basic save flow from open to Ctrl+S', ...)
```

回帰テスト:

```ts
describe('regression: issue#NNN', () => {
  it('should ...', ...)  // skip 禁止
});
```

### Step 6: 設計書の出力

```
Write: docs/test-process/03-design.md
  - §2 適用するテスト技法（技法ごとの適用対象と具体例）
  - §3 テストレベル設計（Unit/Integration/Component/E2E/手動の詳細）
  - §4 テストデータ設計（fixture / mock 方針）
  - §5 優先度マトリクス（モジュール別）
  - §6 粒度ルール（1 it = 1 assertion）
  - §7 命名規約（ID 体系・モジュール略号）
  - §8 未解決事項
```

### Step 7: レビュー依頼（推奨）

設計書完成後、`architect`（ぼたん）に以下を確認依頼:
- テスト技法の選択が適切か
- ペアワイズ生成ツールの採用可否
- 大規模 fixture のビルドコストへの影響

## 粒度ルール（要点）

- **1 it = 1 assertion** を原則とする
- `describe` = 機能単位 / ネスト `describe` = 観点単位 / `it` = 単一シナリオ
- `vi.mock` は外部依存にのみ使用（内部モジュールは実 import 推奨）
- `afterEach(() => vi.clearAllMocks())` で mock リセットを統一

## 想定実行ペルソナ

- `tester_unit`（百鬼あやめ）: Unit + Component の設計
- `tester_integration`（まつり）: Integration + E2E の設計
- `tester`（猫又おかゆ）: 全レベルの実装補助

## 出力例

本リポジトリ `docs/test-process/03-design.md` を参照。

## 関連ドキュメント

- `docs/test-process/01-plan.md` — Phase 1: テスト計画書
- `docs/test-process/02-analysis.md` — Phase 2: テスト分析書（本 skill の入力）
- `docs/test-process/03-design.md` — Phase 3: テスト設計書（本 skill の出力例）
