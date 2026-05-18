import { useRef, useState } from 'react';
import type * as pdfjsLib from 'pdfjs-dist';
import { invoke } from '@tauri-apps/api/core';
import { ask, open } from '@tauri-apps/plugin-dialog';
import { writeFile, remove } from '@tauri-apps/plugin-fs';
import { tempDir, join } from '@tauri-apps/api/path';
import { usePecoStore, selectHasDocument, selectCurrentPageIndex } from '../store/pecoStore';
import { getCachedPageProxy, getSharedPdfProxy, openFreshPdfDoc, getTemporaryPageData } from '../utils/pdfLoader';
import { TextBlock, OcrResult, OcrResultBlock, PecoDocument, BoundingBox } from '../types';
import { useOcrSettingsStore, OcrSortSettings } from '../store/ocrSettingsStore';
import { sortOcrBlocks } from '../utils/ocrSort';
import { logger } from '../utils/logger';
import { perf } from '../utils/perfLogger';

const RENDER_SCALE = 2.0;

/**
 * Render a page from an isolated PDF document (not the shared LRU cache)
 * so it never conflicts with PdfCanvas's concurrent render on the same proxy.
 *
 * 戻り値: (テンポラリ画像パス, scale=1.0 の rotation 適用済み viewport)。
 * viewport は OCR 結果 BB の PDF user space 変換 (#50) に使用する。
 */
async function renderPageToTempFile(
  ocrPdf: pdfjsLib.PDFDocumentProxy,
  pageIndex: number,
): Promise<{ tempPath: string; unscaledViewport: pdfjsLib.PageViewport }> {
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
    // pdfSaver は PDF user space で bbox を扱うため、render scale=1.0 ベースの viewport を返す。
    // rotation はそのまま継承される (scale を変えても /Rotate 情報は同一)。
    const unscaledViewport = page.getViewport({ scale: 1.0 });
    return { tempPath, unscaledViewport };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    page.cleanup();
  }
}

/**
 * Rust 側から返ってくる OCR BB は「画像ピクセルを render_scale で割った値」=
 * `viewport.getViewport({ scale: 1.0 })` のスクリーン座標系（/Rotate 適用後）。
 * pdfSaver は PDF user space で bbox を扱うため、回転ページではここで変換しないと
 * 描画位置がページ外へ飛ぶ (#50)。
 *
 * 4 隅を `viewport.convertToPdfPoint()` で PDF user space に戻し、
 * 軸整列 (axis-aligned) bbox を再構成する。
 */
function convertViewportBBoxToPdfUserSpace(
  bbox: BoundingBox,
  viewport: pdfjsLib.PageViewport,
): BoundingBox {
  // 回転なしならスクリーン座標と PDF user space は y 軸方向だけ反転する関係なので
  // convertToPdfPoint を通せば自動的に正しく変換される。
  // 4 隅を変換してから min/max を取ることで回転後も AABB を維持できる。
  const corners: Array<[number, number]> = [
    [bbox.x, bbox.y],
    [bbox.x + bbox.width, bbox.y],
    [bbox.x, bbox.y + bbox.height],
    [bbox.x + bbox.width, bbox.y + bbox.height],
  ];
  const transformed = corners.map(([x, y]) => viewport.convertToPdfPoint(x, y));
  const xs = transformed.map((p) => p[0]);
  const ys = transformed.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function toTextBlocks(
  blocks: OcrResultBlock[],
  settings: OcrSortSettings,
  viewport?: pdfjsLib.PageViewport | null,
): TextBlock[] {
  const filtered = blocks.filter((b) => b.text.trim() !== '');
  const sorted = sortOcrBlocks(filtered, settings);
  return sorted.map((b, i) => {
    // viewport が無い場合 (テスト等で省略) は変換せずそのまま使う。
    // 通常経路では viewport は必ず渡される。
    const bbox = viewport ? convertViewportBBoxToPdfUserSpace(b.bbox, viewport) : b.bbox;
    return {
      id: crypto.randomUUID(),
      text: b.text,
      originalText: b.text,
      bbox,
      writingMode: b.writingMode,
      order: i,
      isNew: true,
      isDirty: true,
    };
  });
}

async function runOcrForPage(
  ocrPdf: pdfjsLib.PDFDocumentProxy,
  _filePath: string,
  pageIndex: number,
  pageWidth: number,
  pageHeight: number,
): Promise<{ result: OcrResult; unscaledViewport: pdfjsLib.PageViewport | null }> {
  let tempPath: string | null = null;
  let unscaledViewport: pdfjsLib.PageViewport | null = null;
  try {
    const rendered = await renderPageToTempFile(ocrPdf, pageIndex);
    tempPath = rendered.tempPath;
    unscaledViewport = rendered.unscaledViewport;
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
      return {
        result: { status: 'error', blocks: [], message: `JSONパース失敗: ${e}` },
        unscaledViewport,
      };
    }
    return { result: parsed, unscaledViewport };
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
  /**
   * #48: 戻り値で保存成功/失敗を明示的に返す。フォルダ OCR ループは false を
   * 受け取ったら即座に中止する。store の isDirty を後追いで判定するのは
   * IDB の async save が non-atomic で残るため false positive が出る。
   */
  savePdf?: () => Promise<boolean>;
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
          const { result, unscaledViewport } = await runOcrForPage(
            ocrPdf,
            doc.filePath,
            i,
            size.pageWidth,
            size.pageHeight,
          );
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
          // #50: 回転ページでは OCR の BB が rotated viewport 座標で返るため、
          // PDF user space へ変換してから store に入れる。
          const newBlocks = toTextBlocks(result.blocks ?? [], settings, unscaledViewport);
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

    // メモリ上の textBlocks に加えて、LRU 退避済みページが IDB に残しているかも確認する。
    // (issue #9: LRU 退避ページに対する OCR が既存編集を黙って上書きする)
    let hasExistingBlocks = (pageData.textBlocks?.length ?? 0) > 0;
    if (!hasExistingBlocks) {
      try {
        const idbData = await getTemporaryPageData(doc.filePath, pageIdx);
        if ((idbData?.textBlocks?.length ?? 0) > 0) {
          hasExistingBlocks = true;
        }
      } catch (e) {
        console.warn(`[OCR] IDB 退避データの確認に失敗 (page ${pageIdx + 1}):`, e);
      }
    }

    if (hasExistingBlocks) {
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
      const { result, unscaledViewport } = await runOcrForPage(
        ocrPdf,
        doc.filePath,
        pageIdx,
        pageData.width,
        pageData.height,
      );
      if (!isCurrentDocument(doc.filePath)) {
        showToast('OCR結果は破棄されました（別のPDFが開かれました）。', true);
        return;
      }

      if (result.status === 'error') {
        showToast(`OCRエラー: ${result.message}`, true);
        return;
      }

      const settings = useOcrSettingsStore.getState();
      // #50: 回転ページでは OCR の BB が rotated viewport 座標で返るため、
      // PDF user space へ変換してから store に入れる。
      const newBlocks = toTextBlocks(result.blocks ?? [], settings, unscaledViewport);
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
        // #48: savePdf の戻り値で成功/失敗を明示判定する。
        // 旧実装は store の isDirty を見ていたが、saveTemporaryPageData の async は
        // non-atomic で残るため false positive 中止が起きていた。
        const saved = await callbacks.savePdf();
        if (!saved) {
          showToast(`${fileName} の保存に失敗しました。フォルダOCRを中止します。`, true);
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
