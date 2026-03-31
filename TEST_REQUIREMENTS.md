# PecoTool v2 自動テスト要件

## テスト戦略

| レイヤー | フレームワーク | 対象 |
|---------|--------------|------|
| ユニット | Vitest | `utils/`, `store/` |
| コンポーネント | Vitest + @testing-library/react | `src/components/` |
| E2E | Playwright (Tauri WebDriver) | アプリ全体の操作フロー |

### セットアップコマンド（Phase 1–2）
```bash
npm install -D vitest @vitest/coverage-v8 @testing-library/react @testing-library/user-event jsdom
```

---

## Phase 1 — ユニットテスト

### pdfLoader.ts

- [x] **U-L-01** 縦書き検出：`transform[0]=0, transform[1]=1` → `writingMode === 'vertical'`
- [x] **U-L-02** 横書き検出：`transform[0]=1, transform[1]=0` → `writingMode === 'horizontal'`
- [x] **U-L-03** Y座標変換（横書き）：`viewport.height=800, transform[5]=700, height=20` → `bbox.y ≈ 83`
- [x] **U-L-04** 幅フォールバック：`item.width=0, height=12, str="ABC"` → `bbox.width = 21.6`
- [x] **U-L-05** 空文字フィルタリング：`item.str = "  "` → TextBlock に含まれない
- [x] **U-L-06** height フォールバック：`item.height=0, transform[3]=14` → `height = 14`

### pdfSaver.ts

- [x] **U-S-01** 横書きブロックのY座標：`bbox.y=100, bbox.height=20, pageHeight=842` → `drawText y = 725`（ベースライン補正 ×0.85 込み）
- [x] **U-S-02** 縦書きブロックのY座標：`bbox.y=100, pageHeight=842` → `drawText y = 742`
- [x] **U-S-03** 縦書きブロックの回転：`writingMode='vertical'` → `rotate = degrees(-90)`
- [x] **U-S-04** 縦書きブロックのフォントサイズ：`bbox.width=15, bbox.height=200` → `size = 15`
- [x] **U-S-05** 横書きブロックのフォントサイズ：`bbox.width=200, bbox.height=20` → `size = 20`
- [x] **U-S-06** `isDirty=false` のページをスキップ → `drawText` が呼ばれない
- [x] **U-S-07** エンコードエラーのスキップ → `console.warn` のみ、処理継続

### pecoStore.ts

- [x] **U-ST-01** Undo スタック追加：`pushAction(action)` → `undoStack` に action が積まれる
- [x] **U-ST-02** Undo 実行：`undo()` → before 状態に戻り、redoStack に移動
- [x] **U-ST-03** Redo 実行：`redo()` → after 状態に戻り、undoStack に移動
- [x] **U-ST-04** Undo スタック上限：101 回 `pushAction()` → `undoStack.length === 100`（FIFO）
- [x] **U-ST-05** ページデータ更新：`updatePageData(0, { isDirty: true })` → 対象ページのみ更新
- [x] **U-ST-06** 選択 ID 管理：`toggleSelection` / `clearSelection` の動作確認

---

## Phase 2 — コンポーネントテスト・統合テスト

### OcrCard

- [ ] **C-OC-01** テキスト編集が store に反映：contentEditable で blur → `block.text` 更新、`isDirty=true`
- [ ] **C-OC-02** 縦書きバッジ表示：`writingMode='vertical'` → "縦書き" ラベルが表示
- [ ] **C-OC-03** writingMode トグル：バッジをクリック → `writingMode` が反転、`isDirty=true`
- [ ] **C-OC-04** dirty インジケーター：`isDirty=true` → "●" が表示
- [ ] **C-OC-05** 選択時のスタイル：`isSelected=true` → `selected` クラスが付く
- [ ] **C-OC-06** クリックで選択：カードをクリック → `setSelectedIds` が呼ばれる

### OcrEditor

- [ ] **C-OE-01** 検索フィルター：検索ボックスに "abc" 入力 → "abc" を含む block のカードのみ表示
- [ ] **C-OE-02** 検索フィルター（大文字小文字無視）："ABC" 入力、`block.text="abc"` → カードが表示される
- [ ] **C-OE-03** 検索クリアで全件表示：入力欄を空にする → 全カード表示

### TextPreviewWindow

- [ ] **C-PW-01** preview-update イベントで描画更新：Tauri イベントを発火 → 受け取ったテキストが表示
- [ ] **C-PW-02** 全てコピーボタン：クリック → `navigator.clipboard.writeText` が呼ばれる
- [ ] **C-PW-03** 閉じるボタン：クリック → ウィンドウが非表示（hide 呼び出し）

### 統合テスト

- [ ] **I-01** テキスト抽出パイプライン（横書き）：横書きPDFを `loadPage` → `writingMode='horizontal'`、bbox が正値
- [ ] **I-02** テキスト抽出パイプライン（縦書き）：縦書きOCR入りPDFを `loadPage` → `writingMode='vertical'`、bbox が縦長
- [ ] **I-03** ブロックマージ：複数ブロックを選択して merge → 結合テキストが正しい順序、bbox が全体を包む
- [ ] **I-04** Undo/Redo サイクル：テキスト編集 → undo → redo → 編集前→後→後の状態が一致
- [ ] **I-05** 保存→再読み込み：`savePDF` → `loadPage` → テキストブロックが保存内容と一致
- [ ] **I-06** 縦書きPDFの保存：縦書きブロックを含む状態で `savePDF` → 出力PDFのテキストオブジェクトに `rotate=-90°`
- [ ] **I-07** 重複削除：同一テキスト・同一bbox の2ブロック → 1ブロックに削減
- [ ] **I-08** テキストプレビューの順序：縦書き＋横書き混在ページ → order 順に連結、縦書きは改行区切り

---

## Phase 3 — E2Eテスト（Playwright + Tauri WebDriver）

### ファイル操作

- [ ] **E-F-01** PDFを開く：ファイルダイアログでPDF選択 → サムネイル表示、テキストブロックが canvas に描画
- [ ] **E-F-02** 上書き保存：編集後 Ctrl+S → ファイルが更新（タイムスタンプ変化）
- [ ] **E-F-03** 名前を付けて保存：別パスを指定 → 新ファイルが生成、ウィンドウタイトルが変化
- [ ] **E-F-04** 未保存状態のタイトル：ブロック編集後 → タイトルバーにダーティマーク

### キャンバス操作

- [ ] **E-C-01** 新規BBの描画：描画モードでドラッグ → 新しい TextBlock が store に追加、赤枠で表示
- [ ] **E-C-02** BBの移動：BB中央をドラッグ → `bbox.x/y` が変化、`isDirty=true`
- [ ] **E-C-03** BBのリサイズ：角ハンドルをドラッグ → `bbox.width/height` が変化
- [ ] **E-C-04** BBの分割：split モードで BB 内クリック → 2ブロックに分割、テキストが前後に分かれる
- [ ] **E-C-05** 複数選択：Ctrl+クリックで2ブロック → 2ブロックが青ハイライト
- [ ] **E-C-06** 縦長BB を手動描画：縦長にドラッグ（height > width×1.5）→ `writingMode='vertical'` で作成

### キーボードショートカット

- [ ] **E-K-01** Ctrl+Z（Undo）：テキスト編集後 Ctrl+Z → 編集前のテキストに戻る
- [ ] **E-K-02** Ctrl+Y（Redo）：Undo 後 Ctrl+Y → 編集内容が復元
- [ ] **E-K-03** Ctrl+0（フィット）：Ctrl+0 → PDFがウィンドウ幅に収まるズームに変化
- [ ] **E-K-04** Ctrl+ホイール（ズーム）：Ctrl+マウスホイール上 → ズームレベルが増加
- [ ] **E-K-05** 矢印キー（ページ移動）：↓/↑ キー → `currentPage` が増減
- [ ] **E-K-06** Delete キー：ブロック選択後 Delete → ブロックが削除

### プレビューウィンドウ

- [ ] **E-P-01** プレビューウィンドウの起動：アプリ起動 → 2つ目のウィンドウが表示
- [ ] **E-P-02** 編集内容のリアルタイム反映：テキスト編集後 → プレビューウィンドウのテキストが更新
- [ ] **E-P-03** 全てコピーボタン：クリック → クリップボードに全テキストがコピー
