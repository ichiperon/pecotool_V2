import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ask } from '@tauri-apps/plugin-dialog';
import { writeFile, remove } from '@tauri-apps/plugin-fs';
import { tempDir, join } from '@tauri-apps/api/path';
import { usePecoStore } from '../store/pecoStore';
import { getCachedPageProxy, getSharedPdfProxy } from '../utils/pdfLoader';
import { TextBlock, OcrResult, OcrResultBlock, PecoDocument } from '../types';
import { useOcrSettingsStore, OcrSortSettings } from '../store/ocrSettingsStore';
import { sortOcrBlocks } from '../utils/ocrSort';

const RENDER_SCALE = 2.0;

async function renderPageToTempFile(filePath: string, pageIndex: number): Promise<string> {
  const page = await getCachedPageProxy(filePath, pageIndex);
  const viewport = page.getViewport({ scale: RENDER_SCALE });

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;

  const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'));
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  const tmp = await tempDir();
  const fileName = `peco_ocr_${pageIndex}_${Date.now()}.png`;
  const tempPath = await join(tmp, fileName);
  await writeFile(tempPath, bytes);
  return tempPath;
}

function toTextBlocks(blocks: OcrResultBlock[], settings: OcrSortSettings): TextBlock[] {
  const filtered = blocks.filter((b) => b.text.trim() !== '');
  const sorted = sortOcrBlocks(filtered, settings);
  return sorted.map((b, i) => ({
      id: crypto.randomUUID(),
      text: b.text,
      originalText: b.text,
      bbox: b.bbox,
      writingMode: b.writingMode,
      order: i,
      isNew: true,
      isDirty: true,
    }));
}

async function runOcrForPage(
  filePath: string,
  pageIndex: number,
  pageWidth: number,
  pageHeight: number,
): Promise<OcrResult> {
  let tempPath: string | null = null;
  try {
    tempPath = await renderPageToTempFile(filePath, pageIndex);
    const raw = await invoke<string>('run_ocr', {
      imagePath: tempPath,
      pageWidth,
      pageHeight,
      renderScale: RENDER_SCALE,
    });
    let parsed: OcrResult;
    try {
      parsed = JSON.parse(raw) as OcrResult;
    } catch (e) {
      return { status: 'error', blocks: [], message: `JSONパース失敗: ${e}` };
    }
    return parsed;
  } finally {
    if (tempPath) {
      remove(tempPath).catch((e) => {
        console.warn(`[OCR] テンポラリファイルの削除に失敗: ${tempPath}`, e);
      });
    }
  }
}

export function useOcrEngine(showToast: (msg: string, isError?: boolean) => void) {
  const [isOcrRunning, setIsOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<{ current: number; total: number } | null>(null);
  const cancelTokenRef = useRef(false);

  // 描画タイミングに依存しないよう、非同期処理では getState() で最新状態を取得する
  const { document: reactDoc, currentPageIndex } = usePecoStore();

  const runOcrCurrentPage = async () => {
    // 最新状態を取得
    const state = usePecoStore.getState();
    const doc = state.document;
    const pageIdx = state.currentPageIndex;
    if (!doc) return;
    const pageData = doc.pages.get(pageIdx);
    if (!pageData) return;

    if ((pageData.textBlocks?.length ?? 0) > 0) {
      const confirmed = await ask(
        'このページには既存のOCRデータがあります。上書きしますか？',
        { title: 'OCR上書き確認', kind: 'warning' }
      );
      if (!confirmed) return;
    }

    setIsOcrRunning(true);
    try {
      console.log(`[OCR] ページ ${pageIdx + 1} OCR実行中...`);
      const result = await runOcrForPage(doc.filePath, pageIdx, pageData.width, pageData.height);

      if (result.status === 'error') {
        showToast(`OCRエラー: ${result.message}`, true);
        return;
      }

      const settings = useOcrSettingsStore.getState();
      const newBlocks = toTextBlocks(result.blocks ?? [], settings);
      usePecoStore.getState().updatePageData(pageIdx, { textBlocks: newBlocks, isDirty: true }, true);
      showToast(`OCRが完了しました（${newBlocks.length}件）`);
    } catch (e) {
      console.error('[OCR] エラー:', e);
      showToast(`OCRに失敗しました: ${e}`, true);
    } finally {
      setIsOcrRunning(false);
    }
  };

  const runOcrAllPages = async () => {
    // 最新状態を取得（checkAndPromptOcrZero から呼ばれた場合もstaleにならないよう）
    const doc = usePecoStore.getState().document;
    if (!doc) return;

    const confirmed = await ask(
      '全ページOCRを実行します。この操作はUndo できません。続行しますか？',
      { title: '全ページOCR確認', kind: 'warning' }
    );
    if (!confirmed) return;

    const hasExisting = Array.from(doc.pages.values()).some(
      (p) => (p.textBlocks?.length ?? 0) > 0
    );
    if (hasExisting) {
      const overwriteConfirmed = await ask(
        '一部のページに既存OCRデータがあります。全て上書きしますか？',
        { title: '上書き確認', kind: 'warning' }
      );
      if (!overwriteConfirmed) return;
    }

    cancelTokenRef.current = false;
    setIsOcrRunning(true);
    setOcrProgress({ current: 0, total: doc.totalPages });

    try {
      for (let i = 0; i < doc.totalPages; i++) {
        if (cancelTokenRef.current) break;

        setOcrProgress({ current: i + 1, total: doc.totalPages });
        console.log(`[OCR] 処理中: ${i + 1} / ${doc.totalPages} ページ`);

        // ページデータがロード済みならそのサイズを使用。未ロードの場合は pdfjs から取得
        const pageData = usePecoStore.getState().document?.pages.get(i);
        let pageWidth = pageData?.width ?? 0;
        let pageHeight = pageData?.height ?? 0;

        if (pageWidth === 0 || pageHeight === 0) {
          try {
            const page = await getCachedPageProxy(doc.filePath, i);
            const viewport = page.getViewport({ scale: 1.0 });
            pageWidth = viewport.width;
            pageHeight = viewport.height;
          } catch (e) {
            console.warn(`[OCR] ページ ${i + 1}: サイズ取得失敗、スキップします`, e);
            continue;
          }
        }

        try {
          const result = await runOcrForPage(doc.filePath, i, pageWidth, pageHeight);
          if (result.status === 'error') {
            console.error(`[OCR] ページ ${i + 1} エラー: ${result.message}`);
            continue;
          }
          const settings = useOcrSettingsStore.getState();
          const newBlocks = toTextBlocks(result.blocks ?? [], settings);
          usePecoStore.getState().updatePageData(i, { textBlocks: newBlocks, isDirty: true }, false);
        } catch (e) {
          console.error(`[OCR] ページ ${i + 1} 失敗:`, e);
        }
      }
    } finally {
      setIsOcrRunning(false);
      setOcrProgress(null);
    }

    if (cancelTokenRef.current) {
      showToast('OCRをキャンセルしました');
    } else {
      showToast('全ページOCRが完了しました');
    }
  };

  const cancelOcr = () => {
    cancelTokenRef.current = true;
  };

  const checkAndPromptOcrZero = async (doc: PecoDocument) => {
    try {
      const pdf = await getSharedPdfProxy(doc.filePath);
      const page0 = await pdf.getPage(1);
      const content = await page0.getTextContent();
      const hasText = content.items.some((item: any) => item.str?.trim() !== '');

      if (!hasText) {
        const confirmed = await ask(
          'このPDFにはOCRデータが含まれていません。全ページOCRを実行しますか？',
          { title: 'OCR実行の提案', kind: 'info' }
        );
        if (confirmed) await runOcrAllPages();
      }
    } catch (e) {
      console.error('[OCR] OCRゼロ検出に失敗:', e);
    }
  };

  // reactDoc / currentPageIndex は Toolbar の disabled 制御用に返す
  return {
    isOcrRunning,
    ocrProgress,
    runOcrCurrentPage,
    runOcrAllPages,
    cancelOcr,
    checkAndPromptOcrZero,
    hasDocument: !!reactDoc,
    currentPageIndex,
  };
}
