# PecoTool v2 自動テスト要件

## テスト戦略

| レイヤー | フレームワーク | 対象 | ステータス |
|---------|--------------|------|-----------|
| ユニット | Vitest | `utils/`, `store/` | **完了 (65/65)** |
| コンポーネント | Vitest + RTL | `src/components/` | **完了** |
| 統合テスト | Vitest | ページ跨ぎ・保存フロー | **完了** |

---

## Phase 1 — ユニットテスト [COMPLETED]

### pdfLoader.ts
- [x] **U-L-01** 縦書き検出：`transform[0]=0, transform[1]=1` → `writingMode === 'vertical'`
- [x] **U-L-02** 横書き検出：`transform[0]=1, transform[1]=0` → `writingMode === 'horizontal'`
- [x] **U-L-03** Y座標変換（横書き）：`viewport.height=800, transform[5]=700, height=20` → `bbox.y ≈ 83`
- [x] **U-L-04** 幅フォールバック：`item.width=0, height=12, str="ABC"` → `bbox.width = 21.6`
- [x] **U-L-05** 空文字フィルタリング：`item.str = "  "` → TextBlock に含まれない
- [x] **U-L-06** height フォールバック：`item.height=0, transform[3]=14` → `height = 14`

### pdfSaver.ts
- [x] **U-S-01** 横書きブロックのY座標：`bbox.y=100, bbox.height=20, pageHeight=842` → `drawText y = 725`
- [x] **U-S-02** 縦書きブロックのY座標：`bbox.y=100, pageHeight=842` → `drawText y = 742`
- [x] **U-S-03** 縦書きブロックの回転：`writingMode='vertical'` → `rotate = degrees(-90)`
- [x] **U-S-04** 縦書きブロックのフォントサイズ：`bbox.width=15, bbox.height=200` → `size = 15`
- [x] **U-S-05** 横書きブロックのフォントサイズ：`bbox.width=200, bbox.height=20` → `size = 20`
- [x] **U-S-06** `isDirty=false` のページをスキップ → `drawText` が呼ばれない
- [x] **U-S-07** エンコードエラーのスキップ → `console.warn` のみ、処理継続
- [x] **U-S-08** (NEW) PDF破壊防止：Contentsストリームの直接改変を廃止し、安全な追記方式を採用
- [x] **U-S-09** (NEW) ファイルサイズ抑制：標準フォント（Helvetica）の使用による爆増防止

### pecoStore.ts
- [x] **U-ST-01** Undo スタック追加：`pushAction(action)` → `undoStack` に action が積まれる
- [x] **U-ST-02** Undo 実行：`undo()` → before 状態に戻り、redoStack に移動
- [x] **U-ST-03** Redo 実行：`redo()` → after 状態に戻り、undoStack に移動
- [x] **U-ST-04** Undo スタック上限：101 回 `pushAction()` → `undoStack.length === 100`
- [x] **U-ST-05** ページデータ更新：`updatePageData(0, { isDirty: false })` → 全体の `isDirty` は更新されない
- [x] **U-ST-06** 選択 ID 管理：`toggleSelection` / `clearSelection` の動作確認

---

## Phase 2 — コンポーネントテスト・統合テスト [COMPLETED]

### OcrCard / Editor
- [x] **C-OC-01** テキスト編集が store に反映：contentEditable で blur → `block.text` 更新、`isDirty=true`
- [x] **C-OC-02** 縦書きバッジ表示
- [x] **C-OC-03** writingMode トグル
- [x] **C-OC-04** dirty インジケーター
- [x] **C-OC-05** 選択時のスタイル
- [x] **C-OC-06** クリックで選択
- [x] **C-OE-01** 検索フィルター
- [x] **C-OE-02** 検索フィルター（大文字小文字無視）
- [x] **C-OE-03** 検索クリアで全件表示
- [x] **C-M-01** (NEW) マリン監修：Ctrl+矢印キーによるカード間ナビゲーション
- [x] **C-M-02** (NEW) マリン監修：選択カードへの自動スクロール（エディタ＆画像エリア連動）
- [x] **C-M-03** (NEW) マリン監修：BBリサイズ中のスクロール抑制（チカチカ防止）

### 統合テスト
- [x] **I-01** テキスト抽出パイプライン（横書き）
- [x] **I-02** テキスト抽出パイプライン（縦書き）
- [x] **I-03** ブロックマージ
- [x] **I-04** Undo/Redo サイクル
- [x] **I-06** 縦書きPDFの保存
- [x] **I-07** 重複削除
- [x] **I-08** テキストプレビューの順序

---

*※Phase 3 (E2E) は環境の都合上、実機での手動確認をもって代替とする。*
