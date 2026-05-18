import { useRef, useState } from 'react';
import type * as pdfjsLib from 'pdfjs-dist';
import { invoke } from '@tauri-apps/api/core';
import { ask, open } from '@tauri-apps/plugin-dialog';
import { writeFile, remove } from '@tauri-apps/plugin-fs';
import { tempDir, join } from '@tauri-apps/api/path';
import { usePecoStore, selectHasDocument, selectCurrentPageIndex } from '../store/pecoStore';
import { getCachedPageProxy, getSharedPdfProxy, openFreshPdfDoc } from '../utils/pdfLoader';
import { TextBlock, OcrResult, OcrResultBlock, PecoDocument } from '../types';
import { useOcrSettingsStore, OcrSortSettings } from '../store/ocrSettingsStore';
import { sortOcrBlocks } from '../utils/ocrSort';
import { logger } from '../utils/logger';
import { perf } from '../utils/perfLogger';

const RENDER_SCALE = 2.0;

/**
 * Render a page from an isolated PDF document (not the shared LRU cache)
 * so it never conflicts with PdfCanvas's concurrent render on the same proxy.
 */
async function renderPageToTempFile(ocrPdf: pdfjsLib.PDFDocumentProxy, pageIndex: number): Promise<string> {
  const page = await ocrPdf.getPage(pageIndex + 1);
  const canvas = document.createElement('canvas');
  try {
    const viewport = page.getViewport({ scale: RENDER_SCALE });

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
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    page.cleanup();
  }
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
  ocrPdf: pdfjsLib.PDFDocumentProxy,
  _filePath: string,
  pageIndex: number,
  pageWidth: number,
  pageHeight: number,
): Promise<OcrResult> {
  let tempPath: string | null = null;
  try {
    tempPath = await renderPageToTempFile(ocrPdf, pageIndex);
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

type OcrProgress = {
  current: number;
  total: number;
  fileCurrent?: number;
  fileTotal?: number;
  fileName?: string;
};

interface FolderOcrCallbacks {
  openPdf?: (filePath: string) => Promise<boolean>;
  savePdf?: () => Promise<void>;
}

export function useOcrEngine(
  showToast: (msg: string, isError?: boolean) => void,
  callbacks: FolderOcrCallbacks = {},
) {
  const [isOcrRunning, setIsOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<OcrProgress | null>(null);
  const cancelTokenRef = useRef(false);
  const isOcrRunningRef = useRef(false);

  // 描画タイミングに依存しないよう、非同期処理では getState() で最新状態を取得する。
  // Toolbar の disabled 制御に必要な「document の有無」と「現在ページ」だけ細粒度購読し、
  // テキスト編集等の document 全体差し替えで本フックが再 render されないようにする。
  const hasDocument = usePecoStore(selectHasDocument);
  const currentPageIndex = usePecoStore(selectCurrentPageIndex);

  const isCurrentDocument = (filePath: string) =>
    usePecoStore.getState().document?.filePath === filePath;

  const setOcrRunning = (running: boolean) => {
    isOcrRunningRef.current = running;
    setIsOcrRunning(running);
  };

  const getPageSize = async (
    ocrPdf: pdfjsLib.PDFDocumentProxy,
    pageIndex: number,
    pageData?: { width: number; height: number },
  ) => {
    let pageWidth = pageData?.width ?? 0;
    let pageHeight = pageData?.height ?? 0;

    if (pageWidth === 0 || pageHeight === 0) {
      const page = await ocrPdf.getPage(pageIndex + 1);
      try {
        const viewport = page.getViewport({ scale: 1.0 });
        pageWidth = viewport.width;
        pageHeight = viewport.height;
      } finally {
        page.cleanup();
      }
    }

    return { pageWidth, pageHeight };
  };

  const processAllPages = async (
    doc: PecoDocument,
    progressForPage?: (pageIndex: number) => OcrProgress,
  ) => {
    const ocrPdf = await openFreshPdfDoc(doc.filePath);
    try {
      for (let i = 0; i < doc.totalPages; i++) {
        if (cancelTokenRef.current) break;
        if (!isCurrentDocument(doc.filePath)) {
          cancelTokenRef.current = true;
          showToast('OCRを中止しました（別のPDFが開かれました）。', true);
          break;
        }

        setOcrProgress(progressForPage ? progressForPage(i) : { current: i + 1, total: doc.totalPages });
        logger.log(`[OCR] 処理中: ${i + 1} / ${doc.totalPages} ページ`);

        let size: { pageWidth: number; pageHeight: number };
        try {
          const pageData = usePecoStore.getState().document?.pages.get(i);
          size = await getPageSize(ocrPdf, i, pageData);
        } catch (e) {
          console.warn(`[OCR] ページ ${i + 1}: サイズ取得失敗、スキップします`, e);
          continue;
        }

        try {
          const result = await runOcrForPage(ocrPdf, doc.filePath, i, size.pageWidth, size.pageHeight);
          if (!isCurrentDocument(doc.filePath)) {
            cancelTokenRef.current = true;
            showToast('OCRを中止しました（別のPDFが開かれました）。', true);
            break;
          }
          if (result.status === 'error') {
            console.error(`[OCR] ページ ${i + 1} エラー: ${result.message}`);
            continue;
          }
          const settings = useOcrSettingsStore.getState();
          const newBlocks = toTextBlocks(result.blocks ?? [], settings);
          usePecoStore.getState().updatePageData(i, {
            textBlocks: newBlocks,
            isDirty: true,
            isTextExtracted: true,
            ocrCleared: false,
          }, false);
        } catch (e) {
          console.error(`[OCR] ページ ${i + 1} 失敗:`, e);
        }
        if ((i + 1) % 25 === 0) {
          await ocrPdf.cleanup().catch(() => {});
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      ocrPdf.destroy().catch(() => {});
    }
  };

  const runOcrCurrentPage = async () => {
    // 最新状態を取得
    const state = usePecoStore.getState();
    const doc = state.document;
    const pageIdx = state.currentPageIndex;
    if (!doc) return;
    let pageData = doc.pages.get(pageIdx);
    if (!pageData) {
      // ページが未ロード（LRU退避済みを含む）の場合はサイズだけ取得してOCRを続行
      try {
        const page = await getCachedPageProxy(doc.filePath, pageIdx);
        const viewport = page.getViewport({ scale: 1.0 });
        pageData = { pageIndex: pageIdx, width: viewport.width, height: viewport.height, textBlocks: [], isDirty: false, thumbnail: null };
      } catch (e) {
        showToast(`ページ ${pageIdx + 1} の読み込みに失敗しました。OCRを実行できません。`, true);
        return;
      }
    }

    if ((pageData.textBlocks?.length ?? 0) > 0) {
      const confirmed = await ask(
        'このページには既存のOCRデータがあります。上書きしますか？',
        { title: 'OCR上書き確認', kind: 'warning' }
      );
      if (!confirmed) return;
    }

    setOcrRunning(true);
    perf.mark('ui.ocrRunCurrentPage', { page: pageIdx });
    const ocrPdf = await openFreshPdfDoc(doc.filePath);
    try {
      if (!isCurrentDocument(doc.filePath)) return;
      logger.log(`[OCR] ページ ${pageIdx + 1} OCR実行中...`);
      const result = await runOcrForPage(ocrPdf, doc.filePath, pageIdx, pageData.width, pageData.height);
      if (!isCurrentDocument(doc.filePath)) {
        showToast('OCR結果は破棄されました（別のPDFが開かれました）。', true);
        return;
      }

      if (result.status === 'error') {
        showToast(`OCRエラー: ${result.message}`, true);
        return;
      }

      const settings = useOcrSettingsStore.getState();
      const newBlocks = toTextBlocks(result.blocks ?? [], settings);
      usePecoStore.getState().updatePageData(pageIdx, {
        textBlocks: newBlocks,
        isDirty: true,
        isTextExtracted: true,
        ocrCleared: false,
      }, true);
      showToast(`OCRが完了しました（${newBlocks.length}件）`);
    } catch (e) {
      console.error('[OCR] エラー:', e);
      showToast(`OCRに失敗しました: ${e}`, true);
    } finally {
      ocrPdf.destroy().catch(() => {});
      setOcrRunning(false);
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
    setOcrRunning(true);
    setOcrProgress({ current: 0, total: doc.totalPages });
    perf.mark('ui.ocrRunAllPages', { totalPages: doc.totalPages });

    try {
      await processAllPages(doc);
    } finally {
      setOcrRunning(false);
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

  const runOcrFolder = async () => {
    if (!callbacks.openPdf || !callbacks.savePdf) {
      showToast('フォルダOCRを実行できません。', true);
      return;
    }

    const selected = await open({ directory: true, multiple: false });
    if (!selected || typeof selected !== 'string') return;

    const confirmed = await ask(
      'フォルダ内のPDFをOCRし、各PDFへ上書き保存します。続行しますか？',
      { title: 'フォルダOCR確認', kind: 'warning' }
    );
    if (!confirmed) return;

    let pdfFiles: string[];
    try {
      pdfFiles = await invoke<string[]>('list_pdf_files_in_folder', { folderPath: selected });
    } catch (e) {
      console.error('[OCR] フォルダ内PDF一覧の取得に失敗:', e);
      showToast(`PDF一覧の取得に失敗しました: ${e}`, true);
      return;
    }

    if (pdfFiles.length === 0) {
      showToast('フォルダ内にPDFが見つかりませんでした。');
      return;
    }

    cancelTokenRef.current = false;
    setOcrRunning(true);
    perf.mark('ui.ocrRunFolder', { totalFiles: pdfFiles.length });

    try {
      for (let fileIndex = 0; fileIndex < pdfFiles.length; fileIndex++) {
        if (cancelTokenRef.current) break;
        const filePath = pdfFiles[fileIndex];
        const fileName = filePath.split(/[\\/]/).pop() || filePath;
        setOcrProgress({ current: 0, total: 0, fileCurrent: fileIndex + 1, fileTotal: pdfFiles.length, fileName });

        const opened = await callbacks.openPdf(filePath);
        if (!opened || cancelTokenRef.current) continue;

        const doc = usePecoStore.getState().document;
        if (!doc || doc.filePath !== filePath) continue;

        await processAllPages(doc, (pageIndex) => ({
          current: pageIndex + 1,
          total: doc.totalPages,
          fileCurrent: fileIndex + 1,
          fileTotal: pdfFiles.length,
          fileName,
        }));
        if (cancelTokenRef.current) break;

        setOcrProgress({ current: doc.totalPages, total: doc.totalPages, fileCurrent: fileIndex + 1, fileTotal: pdfFiles.length, fileName });
        await callbacks.savePdf();
        const state = usePecoStore.getState();
        const hasDirtyPages = Array.from(state.document?.pages.values() || []).some((p) => p.isDirty);
        if (state.isDirty || hasDirtyPages) {
          showToast(`${fileName} の保存に失敗した可能性があります。フォルダOCRを中止します。`, true);
          cancelTokenRef.current = true;
          break;
        }
      }
    } finally {
      setOcrRunning(false);
      setOcrProgress(null);
    }

    if (cancelTokenRef.current) {
      showToast('フォルダOCRをキャンセルしました');
    } else {
      showToast('フォルダOCRが完了しました');
    }
  };

  const checkAndPromptOcrZero = async (doc: PecoDocument) => {
    if (isOcrRunningRef.current) return;
    try {
      const pdf = await getSharedPdfProxy(doc.filePath);
      const page0 = await pdf.getPage(1);
      let content: Awaited<ReturnType<pdfjsLib.PDFPageProxy['getTextContent']>>;
      try {
        content = await page0.getTextContent();
      } finally {
        page0.cleanup();
      }
      // pdfjs v5 では items が TextItem | TextMarkedContent の混在配列。str を持つのは TextItem のみ。
      const hasText = content.items.some((item) => {
        const maybeStr = (item as { str?: unknown }).str;
        return typeof maybeStr === 'string' && maybeStr.trim() !== '';
      });

      if (!hasText) {
        const confirmed = await ask(
          'このPDFにはOCRデータが含まれていません。全ページOCRを実行しますか？',
          { title: 'OCR実行の提案', kind: 'info' }
        );
        if (confirmed && isCurrentDocument(doc.filePath)) await runOcrAllPages();
      }
    } catch (e) {
      console.error('[OCR] OCRゼロ検出に失敗:', e);
    }
  };

  // hasDocument / currentPageIndex は Toolbar の disabled 制御用に返す
  return {
    isOcrRunning,
    ocrProgress,
    runOcrCurrentPage,
    runOcrAllPages,
    runOcrFolder,
    cancelOcr,
    checkAndPromptOcrZero,
    hasDocument,
    currentPageIndex,
  };
}
