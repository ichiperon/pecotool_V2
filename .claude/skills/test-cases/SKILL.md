---
name: test-cases
description: Generate concrete test case specifications from Phase 3 design. Triggers on "テストケース", "test cases", "Phase 4 テスト", "ケース仕様書", "テストコード実装".
metadata:
  type: process
  phase: 4
---

# Phase 4: テストケース仕様作成・実装

## 用途

Phase 3 のテスト設計書を入力に、具体的なテストケース仕様を記述し、Vitest / Playwright のテストコードとして実装する。
Critical / High 優先度のギャップ（Phase 2 で特定した抜け漏れ）を最優先で充足し、テストファイルを `src/__tests__/` 配下に追加・拡充する。

元記事（Codex 版）の "Step 4: Test Case Implementation" に相当する。Claude 版では `tester_unit`（あやめ）が unit / component を、`tester_integration`（まつり）が integration / E2E を担当するペアで実施する。

## 前提条件

- Phase 3 成果物 `docs/test-process/03-design.md` が存在すること
- `npm run test` が全件通過している（ベースラインが安定していること）
- 機密 PDF は `src/__tests__/` 配下に絶対にコミットしないこと（`MEMORY.md` 参照）

## 実行手順

1. **ギャップ確認**: Phase 2 分析書 (`docs/test-process/02-analysis.md` §5.3) から未カバーモジュールの一覧を再確認する。
2. **テストケース仕様記述**: Phase 3 の命名規約（`U-XX-NN` / `I-XX-NN` / `C-XX-NN` / `E-XX-NN`）に従い、it ブロックの ID・テスト内容・期待値を `docs/test-process/04-cases.md` に列挙する。
3. **テストコード実装（Unit / Component）**:
   - 対象ファイル: `src/__tests__/unit/<module>.test.ts` / `src/__tests__/components/<Component>.test.tsx`
   - `tester_unit`（あやめ）が担当
   - モック: Tauri API は `vi.mock`、IDB は `fake-indexeddb`
4. **テストコード実装（Integration）**:
   - 対象ファイル: `src/__tests__/integration/<feature>.integration.test.ts`
   - `tester_integration`（まつり）が担当
   - real `pdf-lib` を使用し合成 PDF でシナリオを検証する
5. **テスト実行・確認**:
   ```bash
   npm run test -- --run
   npm run test:pdf:acceptance
   npm run test:state:acceptance
   ```
6. **ケース追加結果の記録**: `docs/test-process/04-cases.md` に追加ケース数・通過数を記録する。

## 想定実行ペルソナ

- Unit / Component: `tester_unit`（百鬼あやめ）
- Integration / E2E: `tester_integration`（まつり）
- 全体調整: `tester`（猫又おかゆ）

## 入力

| 入力 | パス |
|---|---|
| テスト設計書 | `docs/test-process/03-design.md` |
| テスト分析書（ギャップ一覧） | `docs/test-process/02-analysis.md` §5.3 |
| 既存テストファイル | `src/__tests__/**/*.test.ts`, `src/__tests__/**/*.test.tsx` |

## 出力

| 成果物 | パス |
|---|---|
| テストケース仕様書 | `docs/test-process/04-cases.md` |
| 追加・拡充テストファイル | `src/__tests__/unit/infraStore.test.ts` 等（ギャップ充足分） |

## 重要制約

- 合成 PDF は `pdf-lib` で生成する。実 PDF フィクスチャは絶対にコミット禁止。
- `test:pdf:soak` 内のリアル PDF テストを参照するファイルには `// @soak` コメントを付与してコミット対象外とする。
- regression テストは `describe('regression: issue#NNN', ...)` 形式で issue 番号を明記する。

## 参考

- 本リポの過去成果物: `docs/test-process/02-analysis.md`（Phase 2）、`docs/test-process/03-design.md`（Phase 3）
- Zenn 元記事: https://zenn.dev/jam0824/articles/c84a2ef393ee70
