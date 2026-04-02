# 引継書: サムネイル・PDF Canvas 表示不具合の調査

## 問題の概要
- **症状**: サムネイルエリアとPDF Canvasが白紙のみ表示される
- **正常**: OCRテキストエリアは正常動作
- **エラー**: コンソールにエラーなし
- **原因**: 直前の大規模リファクタリング（コミット `e61b0e8`）後に発生

---

## 変更されたファイル一覧（git diff確認済み）

| ファイル | 主な変更内容 |
|---|---|
| `src/App.tsx` | `setThumbnail`, `originalBytes`, `resetDirty` をstore分割から削除 |
| `src/components/PdfCanvas.tsx` | `readFile`を動的importから静的importに変更 + Drawing/AltDrag stateを前方に移動 |
| `src/components/Toolbar/Toolbar.tsx` | 型定義をanyからPecoDocument/PageDataに変更 |
| `src/hooks/useFileOperations.ts` | 未使用の`originalBytes`, `isDirty`等を削除 |
| `src/hooks/usePreviewWindow.ts` | `initPreviewWindow`の戻り値修正 |
| `src/utils/pdf.worker.ts` | `rasterizeQuality`削除、`addDefaultPage: false`追加 |
| `src/utils/pdfSaver.ts` | `import pdfWorkerUrl from './pdf.worker?worker&url'`を削除 |

---

## チェック済みファイル

- [x] `src/App.tsx` - 全体読了
- [x] `src/components/PdfCanvas.tsx` - 全体読了
- [x] `src/components/Sidebar/ThumbnailPanel.tsx` - 全体読了
- [x] `src/utils/pdfLoader.ts` - 全体読了
- [x] `src/utils/pdfSaver.ts` - 全体読了
- [x] `src/utils/pdf.worker.ts` - 全体読了
- [x] `src/store/pecoStore.ts` - 全体読了
- [x] `src/hooks/useFileOperations.ts` - 全体読了
- [x] `src/hooks/usePreviewWindow.ts` - 全体読了
- [x] `src/hooks/useFontLoader.ts` - 全体読了
- [x] `src/hooks/useConsoleLogs.ts` - 全体読了
- [x] `src/main.tsx` - 全体読了
- [x] `vite.config.ts` - 全体読了
- [x] `tsconfig.json` - 全体読了
- [x] `git_diff.txt` - 全体読了

---

## 最有力の怪しい箇所（未修正）

### 1. `pdfSaver.ts` Line 174 - ArrayBuffer転送バグ（確実なバグだが別の問題）

```ts
worker.postMessage({...}, [originalPdfBytes.buffer, fontBytes].filter(Boolean) as any);
```

`fontBytes`（`ArrayBuffer`）がWorkerにtransferされるため、**保存後にメインスレッドのfontBytesが空（detached）になる**。次回保存時にフォントが使えなくなる。ただしこれは保存後の問題であり、今回の「開いた直後に白紙」の原因ではない可能性が高い。

**修正方法**: `fontBytes?.slice()` でコピーを渡す。
```ts
[originalPdfBytes.buffer, fontBytes instanceof ArrayBuffer ? fontBytes.slice() : undefined].filter(Boolean)
```
または転送リストから`fontBytes`を削除。

### 2. `PdfCanvas.tsx` の旧コードの謎

旧コード（リファクタリング前）に以下の行があった:
```ts
const { readFile } = await import('@tauri-apps/plugin-fs');
```

これはReactコンポーネント関数の**非async本体内で`await`を使用**しており、通常はTypeScriptコンパイルエラーになる。しかしVite/esbuildはこれをどう処理するか不明。esbuildが`await`を無視して`Promise`オブジェクトが`readFile`に代入されていた場合、`readFile`は関数ではないためuseEffect内で`TypeError`が発生するはずだが、**エラーが出ていない**。これが「旧コードでは動いていた」理由の謎。

### 3. `PdfCanvas.tsx`内でWorkerSrcが未設定

`PdfCanvas.tsx`は`pdfjsLib`を直接importして`pdfjsLib.getDocument()`を呼ぶが、**`GlobalWorkerOptions.workerSrc`の設定は`pdfLoader.ts`のみ**。

- `pdfLoader.ts`がApp.tsxにimportされているため、モジュール初期化順で`workerSrc`はセットされるはず
- しかしViteのHMR（Hot Module Replacement）やモジュールの読み込み順によっては、`PdfCanvas.tsx`が`pdfLoader.ts`より先に実行される可能性がゼロではない

**確認方法**: `PdfCanvas.tsx`のuseEffectの先頭に以下を追加してデバッグ:
```ts
console.log('workerSrc:', pdfjsLib.GlobalWorkerOptions.workerSrc);
```

---

## 次にチェックすべき箇所（優先順）

### Step 1: まず動作確認の絞り込み

PDFを開いた直後のコンソールログ（`[loadPage]`のログ）が出ているか確認。
`pdfLoader.ts`の118行目に`console.log('[loadPage] page...')`があるので、OCRテキストが読めているなら必ず出るはず。
→ 出ていればPDF読み込み自体は成功している。

### Step 2: PdfCanvas.tsx の useEffect が動いているか確認

`PdfCanvas.tsx`の46行目のuseEffect（filePath依存）に`console.log`を仮追加:
```ts
useEffect(() => {
    console.log('[PdfCanvas] filePath effect fired:', document?.filePath);
    if (!document?.filePath) return;
```

これでeffectが発火しているか確認。

### Step 3: pdfPage が設定されているか確認

`PdfCanvas.tsx`の138行目のuseEffect（pdfPage依存）に追加:
```ts
useEffect(() => {
    console.log('[PdfCanvas] pdfPage:', pdfPage);
    if (!pdfPage || !pdfCanvasRef.current) return;
```

### Step 4: render結果確認

`pdfPage.render()`の後に:
```ts
await renderTaskRef.current.promise;
console.log('[PdfCanvas] render completed, canvas size:', canvas.width, canvas.height);
```

---

## アーキテクチャメモ

- **PDF表示**: `PdfCanvas.tsx`が`readFile(filePath)` → `pdfjsLib.getDocument()` → `page.render(canvas)`
- **サムネイル**: `App.tsx`の`requestThumbnail` → `openPDFTask(bytes)` → `generateThumbnail(proxy, idx)` → blob URL → store
- **OCRテキスト**: `App.tsx`の`loadCurrentPage` → `loadPage(pdf, idx, bboxMeta)` → `updatePageData()`
- **workerSrc設定箇所**: `pdfLoader.ts`のモジュールトップレベル（`GlobalWorkerOptions.workerSrc = workerSrc`）
- **状態管理**: Zustand (`pecoStore.ts`) - `document`オブジェクトはページ遷移のたびに新インスタンス生成

---

## 参考: 変更されていないのに怪しいロジック

`pdfSaver.ts` Line 164〜177:
```ts
const startSave = async () => {
  worker.postMessage({...}, [originalPdfBytes.buffer, fontBytes].filter(Boolean) as any);
};
startSave();
```
`originalPdfBytes.buffer`もtransferされており、保存後に`originalPdfBytes`がdetachedになる可能性。ただし`useFileOperations.ts`では毎回`readFile`で読み直しているので実害は少ないかも。
