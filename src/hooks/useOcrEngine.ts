import { useRef, useState } from 'react';
import type * as pdfjsLib from 'pdfjs-dist';
import { invoke } from '@tauri-apps/api/core';
import { ask, open } from '@tauri-apps/plugin-dialog';
import { usePecoStore, selectHasDocument, selectCurrentPageIndex } from '../store/pecoStore';
import { useInfraStore } from '../store/infraStore';
import { getCachedPageProxy, getSharedPdfProxy, openFreshPdfDoc, getTemporaryPageData } from '../utils/pdfLoader';
import { loadPecoToolBBoxMeta } from '../utils/pdfMetadataLoader';
import { TextBlock, OcrResult, OcrResultBlock, PecoDocument } from '../types';
import { useOcrSettingsStore, OcrSortSettings } from '../store/ocrSettingsStore';
import { sortOcrBlocks } from '../utils/ocrSort';
import { logger } from '../utils/logger';
import { perf } from '../utils/perfLogger';
import { loadPage } from '../utils/pdfTextExtractor';
import { parsePageRange } from '../utils/pageRangeParser';
import { displayToSourcePageIndex, resolvePageId } from '../utils/pageOrder';
import { bboxRectToRotatedScreenRect, rotatedScreenRectToBbox } from '../utils/canvasRotation';

const RENDER_SCALE = 2.0;

/**
 * #204: サンプルページ (先頭・中央・末尾の最大 3 点) の items.length をチェックして
 * テキスト層の有無を判定する純粋ヘルパ (フック外でテスト可能)。
 *
 * @param pdf        getSharedPdfProxy などで取得済みの PDFDocumentProxy
 * @param totalPages ドキュメントの総ページ数
 * @returns 'has_text' : 1 ページ以上でテキスト item が存在する
 *          'all_empty': 全サンプルページで items が 0
 */
export async function detectTextLayerSamples(
  pdf: pdfjsLib.PDFDocumentProxy,
  totalPages: number,
): Promise<'all_empty' | 'has_text'> {
  const sampleNums = Array.from(
    new Set([1, Math.ceil(totalPages / 2), totalPages].filter((n) => n >= 1 && n <= totalPages))
  );

  const countItems = async (pageNum: number): Promise<number> => {
    const page = await pdf.getPage(pageNum);
    try {
      const content = await page.getTextContent();
      return content.items.filter((item) => {
        const maybeStr = (item as { str?: unknown }).str;
        return typeof maybeStr === 'string' && maybeStr.trim() !== '';
      }).length;
    } finally {
      page.cleanup();
    }
  };

  // allSettled: 一部のページで getTextContent が失敗しても残りのサンプルで判定を継続する。
  // rejected になったページは warn して 0 件扱いとする。
  const results = await Promise.allSettled(sampleNums.map(countItems));
  const counts = results.map((r) => {
    if (r.status === 'fulfilled') return r.value;
    console.warn('[OCR] detectTextLayerSamples: サンプルページのテキスト取得に失敗:', r.reason);
    return 0;
  });
  const anyHasText = counts.some((c) => c > 0);
  return anyHasText ? 'has_text' : 'all_empty';
}

/**
 * Render a page from an isolated PDF document (not the shared LRU cache)
 * so it never conflicts with PdfCanvas's concurrent render on the same proxy.
 *
 * 戻り値: PNG bytes (Uint8Array)。
 * Rust 側の run_ocr に直接渡すため、Tauri fs-scope を経由しない (#285 D案)。
 *
 * #71 修正: bbox は viewport 空間のまま store に入れ、pdfSaver が
 *   page.getRotation() を読んで cm で位置補正する設計に統一した。
 */
async function renderPageToBytes(
  ocrPdf: pdfjsLib.PDFDocumentProxy,
  pageIndex: number,
): Promise<Uint8Array> {
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
    return new Uint8Array(arrayBuffer);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    page.cleanup();
  }
}

function toTextBlocks(
  blocks: OcrResultBlock[],
  settings: OcrSortSettings,
): TextBlock[] {
  const filtered = blocks.filter((b) => b.text.trim() !== '');
  const sorted = sortOcrBlocks(filtered, settings);
  return sorted.map((b, i) => {
    // #71: bbox は viewport 空間 (rotated screen coords, y-down) のまま保持する。
    // pdfSaver 側で page.getRotation() を読み、rotation に応じた cm で位置補正する。
    return {
      id: crypto.randomUUID(),
      text: b.text,
      originalText: b.text,
      bbox: b.bbox,
      writingMode: b.writingMode,
      order: i,
      isNew: true,
      isDirty: true,
      // #192: OcrResultBlock.confidence を TextBlock に伝搬する
      confidence: b.confidence,
    };
  });
}

async function runOcrForPage(
  ocrPdf: pdfjsLib.PDFDocumentProxy,
  _filePath: string,
  pageIndex: number,
  pageWidth: number,
  pageHeight: number,
  languageTag?: string,
): Promise<{ result: OcrResult }> {
  // #285 D案: bytes を直接 Rust に渡す。Tauri fs-scope を経由しないため
  // Windows UNC verbatim prefix (\\?\) によるスコープ不一致が発生しない。
  // PCT-101: Array.from(bytes) を廃止し ArrayBuffer を raw body で転送する。
  // 2MB PNG が約 16MB ヒープを消費していた JSON 経由の変換を排除する。
  const bytes = await renderPageToBytes(ocrPdf, pageIndex);
  const body = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
  const raw = await invoke<string>('run_ocr', body, {
    headers: {
      'x-page-width': String(pageWidth),
      'x-page-height': String(pageHeight),
      'x-render-scale': String(RENDER_SCALE),
      'x-language-tag': languageTag ?? '',
    },
  });
  let parsed: OcrResult;
  try {
    parsed = JSON.parse(raw) as OcrResult;
  } catch (e) {
    return {
      result: { status: 'error', blocks: [], message: `JSONパース失敗: ${e}` },
    };
  }
  return { result: parsed };
}

type OcrProgress = {
  current: number;
  total: number;
  fileCurrent?: number;
  fileTotal?: number;
  fileName?: string;
  startedAt: number;
  avgMsPerPage: number;
  estimatedRemainingMs: number;
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
  // #355 (PCT-132): フォルダ OCR ループ全体を止めるかどうかの判定専用フラグ。
  // cancelTokenRef は processAllPages 内の epoch 不一致検知でも立ち、かつフォルダ
  // ループは各ファイル開始時に cancelTokenRef をリセットするため、「ユーザーが
  // cancelOcr() を明示的に押した」ことをこれだけでは区別できない。
  // userCancelRef はユーザー操作 (Esc・進捗 UI のキャンセルボタン) からのみ立て、
  // フォルダループではファイル単位でリセットしない (=一度立ったらフォルダ全体を止める)。
  const userCancelRef = useRef(false);
  const isOcrRunningRef = useRef(false);

  // 描画タイミングに依存しないよう、非同期処理では getState() で最新状態を取得する。
  // Toolbar の disabled 制御に必要な「document の有無」と「現在ページ」だけ細粒度購読し、
  // テキスト編集等の document 全体差し替えで本フックが再 render されないようにする。
  const hasDocument = usePecoStore(selectHasDocument);
  const currentPageIndex = usePecoStore(selectCurrentPageIndex);

  // #102: filePath 一致だけでは F5 (再読み込み) で「同じパスの別 doc 参照」に
  // 古い OCR 結果が書き込まれる事故が発生する。
  // updatePageData は document を新オブジェクトに置き換えるため reference identity も
  // 使えない (1 ページ書き込んだ瞬間に doc が変わる)。
  // 解決策: setDocument 時のみ +1 される documentEpoch を比較する。
  // OCR ループ開始時点の epoch を保持し、毎ステップで getState().documentEpoch と一致するか判定。
  const isCurrentDocument = (capturedEpoch: number) =>
    useInfraStore.getState().documentEpoch === capturedEpoch;

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

  const hasExistingOcrBlocks = async (
    doc: PecoDocument,
    pageIndices: number[],
  ): Promise<boolean> => {
    for (const idx of pageIndices) {
      const page = doc.pages.get(idx);
      if ((page?.textBlocks?.length ?? 0) > 0) return true;
    }

    const pageOrder = usePecoStore.getState().pageOrder;
    for (const idx of pageIndices) {
      try {
        // PCT-104 (A-lite 段階2): displayIndex -> pageId 変換して IDB を読む
        const pageId = resolvePageId(pageOrder, idx);
        const idbData = await getTemporaryPageData(doc.filePath, pageId);
        if ((idbData?.textBlocks?.length ?? 0) > 0) return true;
      } catch (e) {
        console.warn(`[OCR] IDB 退避データの確認に失敗 (page ${idx + 1}):`, e);
      }
    }

    return false;
  };

  const processAllPages = async (
    doc: PecoDocument,
    progressForPage?: (pageIndex: number, timing: { startedAt: number; avgMsPerPage: number; estimatedRemainingMs: number }) => OcrProgress,
    pageIndices?: number[],
    capturedEpochParam?: number,
  ) => {
    // #102: 開始時点の epoch を captured epoch として保持。
    // ループ内で getState().documentEpoch と比較し、F5 / Ctrl+O 経由で document が
    // 差し替えられた瞬間に検知して停止する (filePath 一致でも doc 自体は別物のため)。
    // updatePageData による document 差し替えは epoch を増やさないので、書き込みは正常に続く。
    //
    // #354 (PCT-131): 呼び出し元 (runOcrAllPages/runOcrRange) が ask() 確認ダイアログや
    // hasExistingOcrBlocks の IDB 走査より前に捕捉した epoch を capturedEpochParam で渡す。
    // ここで改めて captured すると「確認ダイアログ待機中に document が切り替わった後の
    // epoch」を捕捉してしまい、以降の一致判定が常に真になって中断ガードが素通しになる。
    // 引数がない呼び出し元 (runOcrFolder / runOcrAllPagesSilent は doc 取得から呼び出し
    // までの間に await を挟まない) はここで新規捕捉して従来どおり動作する。
    const capturedEpoch = capturedEpochParam ?? useInfraStore.getState().documentEpoch;
    // #354: 呼び出し元の待機中に document が切り替わっていたら、PDF を開く前に中断する。
    if (!isCurrentDocument(capturedEpoch)) {
      cancelTokenRef.current = true;
      showToast('OCRを中止しました（別のPDFが開かれました）。', true);
      return;
    }
    const ocrPdf = await openFreshPdfDoc(doc.filePath);

    // #199: 対象ページインデックス一覧。指定がなければ全ページ。
    const targets = pageIndices ?? Array.from({ length: doc.totalPages }, (_, i) => i);
    const pageOrder = usePecoStore.getState().pageOrder;
    const total = targets.length;

    // #200: EMA タイミング変数
    const startedAt = performance.now();
    let avgMsPerPage = 0;
    let pageStartTime = startedAt;

    try {
      for (let step = 0; step < targets.length; step++) {
        const i = targets[step];
        const sourcePageIndex = displayToSourcePageIndex(pageOrder, i);
        if (cancelTokenRef.current) break;
        if (!isCurrentDocument(capturedEpoch)) {
          cancelTokenRef.current = true;
          showToast('OCRを中止しました（別のPDFが開かれました）。', true);
          break;
        }

        pageStartTime = performance.now();

        const timing = { startedAt, avgMsPerPage, estimatedRemainingMs: avgMsPerPage * (total - step) };
        setOcrProgress(
          progressForPage
            ? progressForPage(i, timing)
            : { current: step + 1, total, startedAt, avgMsPerPage, estimatedRemainingMs: timing.estimatedRemainingMs },
        );
        logger.log(`[OCR] 処理中: ${i + 1} / ${doc.totalPages} ページ`);

        let size: { pageWidth: number; pageHeight: number };
        try {
          const pageData = usePecoStore.getState().document?.pages.get(i);
          size = await getPageSize(ocrPdf, sourcePageIndex, pageData);
        } catch (e) {
          console.warn(`[OCR] ページ ${i + 1}: サイズ取得失敗、スキップします`, e);
          continue;
        }

        try {
          const settings = useOcrSettingsStore.getState();
          const { result } = await runOcrForPage(
            ocrPdf,
            doc.filePath,
            sourcePageIndex,
            size.pageWidth,
            size.pageHeight,
            settings.ocrLanguage,
          );

          // #200: ページ完了後の EMA 更新 (α=0.3)
          const pageDurationMs = performance.now() - pageStartTime;
          if (avgMsPerPage === 0) {
            avgMsPerPage = pageDurationMs;
          } else {
            avgMsPerPage = 0.3 * pageDurationMs + 0.7 * avgMsPerPage;
          }

          if (cancelTokenRef.current) break;
          if (!isCurrentDocument(capturedEpoch)) {
            cancelTokenRef.current = true;
            showToast('OCRを中止しました（別のPDFが開かれました）。', true);
            break;
          }
          if (displayToSourcePageIndex(usePecoStore.getState().pageOrder, i) !== sourcePageIndex) {
            cancelTokenRef.current = true;
            showToast('OCRを中止しました（ページ順序が変更されました）。', true);
            break;
          }
          if (result.status === 'error') {
            console.error(`[OCR] ページ ${i + 1} エラー: ${result.message}`);
            continue;
          }
          // #71: bbox は viewport 空間 (rotated screen) のまま store に入れる。
          // pdfSaver が page.getRotation() を読んで cm で位置補正する。
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
        if ((step + 1) % 25 === 0) {
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
    // #354 (PCT-131): doc を読んだ直後、最初の await (getCachedPageProxy / IDB 走査 /
    // ask() 確認ダイアログ) の前に epoch を捕捉する。以前は ask() の後で捕捉していたため、
    // 確認ダイアログ表示中に document が切り替わると「切替後の epoch」を捕捉してしまい、
    // #102 の中断ガードが全行程で素通しになっていた。
    const capturedEpoch = useInfraStore.getState().documentEpoch;
    const sourcePageIndex = displayToSourcePageIndex(state.pageOrder, pageIdx);
    let pageData = doc.pages.get(pageIdx);
    if (!pageData) {
      // ページが未ロード（LRU退避済みを含む）の場合はサイズだけ取得してOCRを続行
      try {
        const page = await getCachedPageProxy(doc.filePath, sourcePageIndex);
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
        // PCT-104 (A-lite 段階2): displayIndex -> pageId 変換して IDB を読む
        const ocrPageOrder = usePecoStore.getState().pageOrder;
        const ocrPageId = resolvePageId(ocrPageOrder, pageIdx);
        const idbData = await getTemporaryPageData(doc.filePath, ocrPageId);
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

    // #354: ここまで (未ロード時の getCachedPageProxy 取得 / IDB 走査 / 上書き確認
    // ask()) の待機中に document が切り替わっていたら OCR を開始せず中断する。
    if (!isCurrentDocument(capturedEpoch)) {
      showToast('OCRを中止しました（別のPDFが開かれました）。', true);
      return;
    }

    cancelTokenRef.current = false;
    userCancelRef.current = false;
    setOcrRunning(true);
    perf.mark('ui.ocrRunCurrentPage', { page: pageIdx });
    const ocrPdf = await openFreshPdfDoc(doc.filePath);
    try {
      if (!isCurrentDocument(capturedEpoch)) return;
      logger.log(`[OCR] ページ ${pageIdx + 1} OCR実行中...`);
      // #PCT-046: processAllPages と同様に getPageSize を経由して寸法を取得する。
      // pageData.width/height が 0 または undefined の場合でも viewport から再取得し、
      // run_ocr の pageWidth/pageHeight に有効な数値が渡されることを保証する。
      let size: { pageWidth: number; pageHeight: number };
      try {
        size = await getPageSize(ocrPdf, sourcePageIndex, pageData);
      } catch (e) {
        showToast(`ページ ${pageIdx + 1} のサイズ取得に失敗しました。OCRを実行できません。`, true);
        return;
      }
      const settings = useOcrSettingsStore.getState();
      const { result } = await runOcrForPage(
        ocrPdf,
        doc.filePath,
        sourcePageIndex,
        size.pageWidth,
        size.pageHeight,
        settings.ocrLanguage,
      );
      if (cancelTokenRef.current) return;
      if (!isCurrentDocument(capturedEpoch)) {
        showToast('OCR結果は破棄されました（別のPDFが開かれました）。', true);
        return;
      }
      if (displayToSourcePageIndex(usePecoStore.getState().pageOrder, pageIdx) !== sourcePageIndex) {
        showToast('OCR結果は破棄されました（ページ順序が変更されました）。', true);
        return;
      }

      if (result.status === 'error') {
        showToast(`OCRエラー: ${result.message}`, true);
        return;
      }
      // #71: bbox は viewport 空間 (rotated screen) のまま store に入れる。
      // pdfSaver が page.getRotation() を読んで cm で位置補正する。
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
    // PCT-076: 多重起動ガード。checkAndPromptOcrZero の ask() 待機中などに
    // 別経路 (バッチジョブ / フォルダ OCR) の OCR が開始していた場合、
    // ここから二本目を起動すると同一ページ群へ並行 updatePageData して
    // OCR 結果が混在するため入口で拒否する。
    if (isOcrRunningRef.current) {
      showToast('OCR実行中のため、新しいOCRを開始できません。', true);
      return;
    }
    // 最新状態を取得（checkAndPromptOcrZero から呼ばれた場合もstaleにならないよう）
    const doc = usePecoStore.getState().document;
    if (!doc) return;
    // #354 (PCT-131): ask() 確認ダイアログや hasExistingOcrBlocks の IDB 走査より前に
    // epoch を捕捉する。processAllPages 側の新規捕捉に任せると、それらの待機中の
    // document 切替を「切替後の epoch」として捕捉してしまい中断ガードが素通しになる。
    const capturedEpoch = useInfraStore.getState().documentEpoch;

    const confirmed = await ask(
      '全ページOCRを実行します。この操作はUndo できません。続行しますか？',
      { title: '全ページOCR確認', kind: 'warning' }
    );
    if (!confirmed) return;

    const hasExisting = await hasExistingOcrBlocks(
      doc,
      Array.from({ length: doc.totalPages }, (_, i) => i),
    );
    if (hasExisting) {
      // PCT-090: 上書きが「テキストの置き換え」であり元の文字と変わりうることを明示する。
      const overwriteConfirmed = await ask(
        '一部のページに既存のテキストがあります。Windows OCR の認識結果で上書きすると、元の文字と異なる結果になる場合があります（記号・旧字などは特に変わりやすい）。\n\n全て上書きしますか？',
        { title: '上書き確認', kind: 'warning' }
      );
      if (!overwriteConfirmed) return;
    }

    // #354: 確認ダイアログ・IDB 走査待機中に document が切り替わっていたら開始しない。
    if (!isCurrentDocument(capturedEpoch)) {
      showToast('OCRを中止しました（別のPDFが開かれました）。', true);
      return;
    }

    cancelTokenRef.current = false;
    userCancelRef.current = false;
    setOcrRunning(true);
    setOcrProgress({ current: 0, total: doc.totalPages, startedAt: performance.now(), avgMsPerPage: 0, estimatedRemainingMs: 0 });
    perf.mark('ui.ocrRunAllPages', { totalPages: doc.totalPages });

    try {
      await processAllPages(doc, undefined, undefined, capturedEpoch);
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
    // #355 (PCT-132): ユーザー明示キャンセルを processAllPages 内部の epoch 検知キャンセル
    // と区別するためのフラグ。folder OCR ループが savePdf をスキップして即停止する判定に使う。
    userCancelRef.current = true;
  };

  /**
   * #195: Batch job helper — run OCR on all pages without confirmation dialogs.
   * Returns true if OCR completed without cancellation, false otherwise.
   */
  const runOcrAllPagesSilent = async (): Promise<boolean> => {
    const doc = usePecoStore.getState().document;
    if (!doc) return false;

    cancelTokenRef.current = false;
    userCancelRef.current = false;
    setOcrRunning(true);
    setOcrProgress({
      current: 0,
      total: doc.totalPages,
      startedAt: performance.now(),
      avgMsPerPage: 0,
      estimatedRemainingMs: 0,
    });

    try {
      await processAllPages(doc);
    } finally {
      setOcrRunning(false);
      setOcrProgress(null);
    }

    return !cancelTokenRef.current;
  };

  // #199: ページ範囲指定 OCR
  const runOcrRange = async (pageRangeString: string) => {
    const doc = usePecoStore.getState().document;
    if (!doc) return;
    // #354 (PCT-131): ask() 確認ダイアログや hasExistingOcrBlocks の IDB 走査より前に
    // epoch を捕捉する（parsePageRange は同期処理のため実質的な競合窓ではないが、
    // 捕捉タイミングを他経路と揃えるためここで統一する）。
    const capturedEpoch = useInfraStore.getState().documentEpoch;

    const parsed = parsePageRange(pageRangeString, doc.totalPages);
    if ('error' in parsed) {
      showToast(`ページ範囲エラー: ${parsed.error}`, true);
      return;
    }

    const pageIndices = parsed;
    if (pageIndices.length === 0) {
      showToast('有効なページが範囲内に存在しません', true);
      return;
    }

    const confirmed = await ask(
      `ページ範囲 OCR を実行します (${pageIndices.length} ページ)。この操作はUndo できません。続行しますか？`,
      { title: 'ページ範囲 OCR 確認', kind: 'warning' }
    );
    if (!confirmed) return;

    const hasExisting = await hasExistingOcrBlocks(doc, pageIndices);
    if (hasExisting) {
      const overwriteConfirmed = await ask(
        '指定ページの一部に既存OCRデータがあります。上書きしますか？',
        { title: '上書き確認', kind: 'warning' }
      );
      if (!overwriteConfirmed) return;
    }

    // #354: 確認ダイアログ・IDB 走査待機中に document が切り替わっていたら開始しない。
    if (!isCurrentDocument(capturedEpoch)) {
      showToast('OCRを中止しました（別のPDFが開かれました）。', true);
      return;
    }

    cancelTokenRef.current = false;
    userCancelRef.current = false;
    setOcrRunning(true);
    setOcrProgress({ current: 0, total: pageIndices.length, startedAt: performance.now(), avgMsPerPage: 0, estimatedRemainingMs: 0 });
    perf.mark('ui.ocrRunRange', { pageCount: pageIndices.length });

    try {
      await processAllPages(doc, undefined, pageIndices, capturedEpoch);
    } finally {
      setOcrRunning(false);
      setOcrProgress(null);
    }

    if (cancelTokenRef.current) {
      showToast('OCRをキャンセルしました');
    } else {
      showToast(`ページ範囲OCRが完了しました（${pageIndices.length} ページ）`);
    }
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
    userCancelRef.current = false;
    setOcrRunning(true);
    perf.mark('ui.ocrRunFolder', { totalFiles: pdfFiles.length });

    // フォルダループ全体のキャンセル判定はローカルフラグで管理する。
    // (#131: processAllPages 内の epoch 不一致検知で cancelTokenRef が立ち、
    //  次ファイルの openPdf 後にも残って全スキップしていた)
    let folderCancelled = false;
    try {
      for (let fileIndex = 0; fileIndex < pdfFiles.length; fileIndex++) {
        // #355 (PCT-132): ユーザーが明示的に cancelOcr() を押していたら、次のファイルを
        // 開く前にフォルダ全体を止める。userCancelRef はファイル単位でリセットしない
        // (下の cancelTokenRef リセットと違い、一度立ったらセッション終了までそのまま)。
        if (folderCancelled || userCancelRef.current) {
          folderCancelled = true;
          break;
        }
        // 各ファイル開始時に cancelTokenRef のみリセットする。
        // 前ファイルで epoch 検知により内部 cancel が立っていても、新ファイルでは正常に処理する。
        cancelTokenRef.current = false;
        const filePath = pdfFiles[fileIndex];
        const fileName = filePath.split(/[\\/]/).pop() || filePath;
        const fileStartedAt = performance.now();
        setOcrProgress({ current: 0, total: 0, fileCurrent: fileIndex + 1, fileTotal: pdfFiles.length, fileName, startedAt: fileStartedAt, avgMsPerPage: 0, estimatedRemainingMs: 0 });

        const opened = await callbacks.openPdf(filePath);
        if (!opened) continue;

        const doc = usePecoStore.getState().document;
        if (!doc || doc.filePath !== filePath) continue;

        await processAllPages(doc, (pageIndex, timing) => ({
          current: pageIndex + 1,
          total: doc.totalPages,
          fileCurrent: fileIndex + 1,
          fileTotal: pdfFiles.length,
          fileName,
          startedAt: timing.startedAt,
          avgMsPerPage: timing.avgMsPerPage,
          estimatedRemainingMs: timing.estimatedRemainingMs,
        }));

        // #355 (PCT-132): ユーザーが明示的に cancelOcr() を押した場合のみフォルダ全体を
        // 停止する。processAllPages が epoch 検知の内部 cancel で抜けた場合は
        // userCancelRef が立たないため、このファイルだけスキップ扱いにして次へ進む
        // (cancelTokenRef は上のリセットで既に処理継続可能)。
        // ユーザーキャンセルを検知した場合は、途中までしか OCR していないこのファイルを
        // savePdf せずに即座にループを抜ける。
        if (userCancelRef.current) {
          folderCancelled = true;
          break;
        }

        setOcrProgress({ current: doc.totalPages, total: doc.totalPages, fileCurrent: fileIndex + 1, fileTotal: pdfFiles.length, fileName, startedAt: fileStartedAt, avgMsPerPage: 0, estimatedRemainingMs: 0 });
        // #48: savePdf の戻り値で成功/失敗を明示判定する。
        // 旧実装は store の isDirty を見ていたが、saveTemporaryPageData の async は
        // non-atomic で残るため false positive 中止が起きていた。
        const saved = await callbacks.savePdf();
        if (!saved) {
          showToast(`${fileName} の保存に失敗しました。フォルダOCRを中止します。`, true);
          folderCancelled = true;
          break;
        }
      }
    } finally {
      setOcrRunning(false);
      setOcrProgress(null);
    }

    if (folderCancelled) {
      showToast('フォルダOCRをキャンセルしました');
    } else {
      showToast('フォルダOCRが完了しました');
    }
  };

  // #204: detectTextLayerSamples はモジュールトップレベルの export 関数に委譲する。
  const detectTextLayerSamplesForDoc = async (
    doc: PecoDocument,
  ): Promise<'all_empty' | 'has_text'> => {
    const pdf = await getSharedPdfProxy(doc.filePath);
    return detectTextLayerSamples(pdf, doc.totalPages);
  };

  /**
   * #204: 全ページのテキスト層を pdfTextExtractor.loadPage 経由で一括取り込む。
   * OCR の代わりにテキスト層がある電子原稿 PDF で使う。
   * ocrProgress には触れず、showToast で進捗を知らせる最小実装。
   */
  const importTextLayerAllPages = async (doc: PecoDocument, capturedEpoch: number) => {
    const total = doc.totalPages;
    const pageOrder = usePecoStore.getState().pageOrder;
    showToast(`テキスト層を取り込み中... (全 ${total} ページ)`);
    logger.log(`[TextLayer] 取り込み開始: ${total} ページ`);

    // PCT-094 (防御): メタが取得できた場合は loadPage に渡し、fallback 経由での
    // bbox 高さ劣化（descent 欠落で約 71% に縮む）を防ぐ。
    // 修正1のスキップにより、メタあり PDF はここへ到達しないはずだが、
    // 将来の呼び出し経路の混入に備えた安全策として維持する。
    let importBBoxMeta: Record<string, Array<{
      bbox: { x: number; y: number; width: number; height: number };
      writingMode: string;
      order: number;
      text: string;
      confidence?: number;
    }>> | null = null;
    try {
      const pdf = await getSharedPdfProxy(doc.filePath);
      importBBoxMeta = await loadPecoToolBBoxMeta(pdf, {
        loadBytes: async () => {
          const { readFile } = await import('@tauri-apps/plugin-fs');
          return readFile(doc.filePath);
        },
        filePath: doc.filePath,
        mtime: doc.mtime,
      });
    } catch {
      // メタロード失敗は無視して従来どおり null (fallback) で続行する
    }

    const BATCH = 10;
    for (let start = 0; start < total; start += BATCH) {
      if (!isCurrentDocument(capturedEpoch)) {
        showToast('テキスト層の取り込みを中止しました（別のPDFが開かれました）。', true);
        return;
      }
      const end = Math.min(start + BATCH, total);
      const pageIndices = Array.from({ length: end - start }, (_, i) => start + i);

      const pageDataList = await Promise.all(
        pageIndices.map((i) => {
          const sourcePageIndex = displayToSourcePageIndex(pageOrder, i);
          return loadPage(
            // loadPage の第 1 引数 (_pdf) は実際は getCachedPageProxy 内で参照するため
            // ダミーの null cast で渡す (既存の呼び出し規約に準ずる)。
            null as unknown as pdfjsLib.PDFDocumentProxy,
            sourcePageIndex,
            doc.filePath,
            // PCT-094: メタあり時はメタを渡してメタ経路で解決させる（null 固定解除）。
            // メタなし PDF の場合は引き続き null → fallback (pdfjs transform 再構成)。
            importBBoxMeta,
            doc.mtime,
            { displayPageIndex: i },
          ).catch((e) => {
            console.warn(`[TextLayer] ページ ${i + 1} 取り込み失敗:`, e);
            return null;
          });
        })
      );

      if (!isCurrentDocument(capturedEpoch)) {
        showToast('テキスト層の取り込みを中止しました（別のPDFが開かれました）。', true);
        return;
      }

      for (let idx = 0; idx < pageIndices.length; idx++) {
        const pageIndex = pageIndices[idx];
        const pageData = pageDataList[idx];
        if (!pageData) continue;
        if (displayToSourcePageIndex(usePecoStore.getState().pageOrder, pageIndex) !== displayToSourcePageIndex(pageOrder, pageIndex)) continue;
        usePecoStore.getState().updatePageData(pageIndex, {
          textBlocks: pageData.textBlocks,
          isDirty: true,
          isTextExtracted: true,
          ocrCleared: false,
        }, false);
      }

      logger.log(`[TextLayer] 取り込み済み: ${end} / ${total} ページ`);
      // UI スレッドを解放
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    showToast(`テキスト層の取り込みが完了しました（全 ${total} ページ）`);
  };

  const checkAndPromptOcrZero = async (doc: PecoDocument) => {
    if (isOcrRunningRef.current) return;
    // #102: doc を渡された瞬間の epoch を保持。ask() の待機中に別 PDF へ切り替わったら
    // runOcrAllPages を起動しない (旧実装は filePath 一致のみ確認していたため、
    // 同 filePath で再ロードされた別 doc に対しても OCR を実行していた)。
    const capturedEpoch = useInfraStore.getState().documentEpoch;
    try {
      // PCT-094: PecoToolBBoxes メタを持つ PDF はここでスキップする。
      // メタあり = PecoTool 管理下の保存済み PDF。通常ページロード経路
      // (usePageNavigation → loadPage) が既にメタ経由で正確に bbox を復元済みのため、
      // テキスト層取り込みは不要かつ有害 (importTextLayerAllPages が loadPage を
      // bboxMeta=null で呼ぶ fallback 経路に落ち、descent 欠落で bbox 高さが約 71% に
      // 縮み、isDirty:true で保存されると劣化が累積する)。
      // テキスト層取り込みは「メタを持たない外部 PDF」専用。
      // メタロードの失敗（例外）は「メタなし」として従来フローへ（安全側）。
      try {
        const pdf = await getSharedPdfProxy(doc.filePath);
        const meta = await loadPecoToolBBoxMeta(pdf, {
          loadBytes: async () => {
            const { readFile } = await import('@tauri-apps/plugin-fs');
            return readFile(doc.filePath);
          },
          filePath: doc.filePath,
          mtime: doc.mtime,
        });
        if (meta !== null && Object.keys(meta).length > 0) {
          // メタあり: 何もせず return
          return;
        }
      } catch {
        // メタロード失敗は「メタなし」扱いで通常フローへ
      }
      if (!isCurrentDocument(capturedEpoch)) return;

      // #204: 3 点サンプリングでテキスト層の有無を判定する。
      const layerResult = await detectTextLayerSamplesForDoc(doc);

      if (layerResult === 'has_text') {
        // PCT-091: テキスト層がある PDF は確認ダイアログなしで自動取り込みする。
        // 旧実装は「取り込む？」→（いいえ）→「OCR を実行する？」の連続ネイティブ
        // ダイアログで、同位置に連続表示されるため意図せず再 OCR（テキスト層の
        // 置き換え）へ入る誤操作が実機で発生した。既存テキストの保全を既定とし、
        // 再 OCR はリボンの OCR 実行からの明示操作（上書き確認つき・PCT-090 文言）に
        // 限定する。
        if (!isCurrentDocument(capturedEpoch)) return;
        await importTextLayerAllPages(doc, capturedEpoch);
      } else {
        // テキスト層なし: 既存挙動 (OCR を促す)
        const confirmed = await ask(
          'このPDFにはOCRデータが含まれていません。全ページOCRを実行しますか？',
          { title: 'OCR実行の提案', kind: 'info' }
        );
        if (confirmed && isCurrentDocument(capturedEpoch)) await runOcrAllPages();
      }
    } catch (e) {
      console.error('[OCR] OCRゼロ検出に失敗:', e);
    }
  };

  /**
   * #191: 矩形範囲指定 OCR。
   * pdfCanvas 上でドラッグした矩形領域（canvas ピクセル座標）をクロップし、
   * 一時ファイルへ書き出して run_ocr に渡す。
   * 結果の OcrResultBlock[] は現在ページの textBlocks に追加する（undoable）。
   *
   * @param sourceCanvas  pdfCanvas (PDF 描画済みの canvas 要素)
   * @param rect          canvas ピクセル座標での矩形 (x, y, width, height)
   * @param pageIndex     現在ページのインデックス
   * @param zoom          現在の zoom (100 = 等倍)
   */
  const runOcrOnRegion = async (
    sourceCanvas: HTMLCanvasElement,
    rect: { x: number; y: number; width: number; height: number },
    pageIndex: number,
    zoom: number,
  ) => {
    const state = usePecoStore.getState();
    const doc = state.document;
    if (!doc) return;

    const pageData = doc.pages.get(pageIndex);
    if (!pageData) {
      showToast(`ページ ${pageIndex + 1} のデータが見つかりません。`, true);
      return;
    }

    // #405 (PCT-174): rect は bbox 空間 (回転前) の座標。UI rotation が
    // かかっているとき、sourceCanvas は回転後の実描画 canvas なので、
    // crop 前に bbox 空間 → rotated screen 空間へ変換する必要がある。
    const pageRotation = pageData.rotation ?? 0;
    const rotParams = pageRotation !== 0
      ? { rotation: pageRotation, vw: sourceCanvas.width, vh: sourceCanvas.height }
      : null;
    const cropRect = rotParams ? bboxRectToRotatedScreenRect(rect, rotParams) : rect;

    // canvas ピクセル座標での矩形 (rotated screen 空間 = sourceCanvas と同じ座標系)
    const sx = Math.round(cropRect.x);
    const sy = Math.round(cropRect.y);
    const sw = Math.round(cropRect.width);
    const sh = Math.round(cropRect.height);

    if (sw < 2 || sh < 2) return;

    cancelTokenRef.current = false;
    userCancelRef.current = false;
    setOcrRunning(true);
    const capturedEpoch = useInfraStore.getState().documentEpoch;
    try {
      // #PCT-046 同根バグ対応: pageData.width/height が 0 の場合は getCachedPageProxy 経由で
      // viewport から再取得する。runOcrCurrentPage と同じフォールバック方式。
      let pageWidth = pageData.width;
      let pageHeight = pageData.height;
      if (pageWidth === 0 || pageHeight === 0) {
        try {
          const sourcePageIndex = displayToSourcePageIndex(state.pageOrder, pageIndex);
          const page = await getCachedPageProxy(doc.filePath, sourcePageIndex);
          const viewport = page.getViewport({ scale: 1.0 });
          pageWidth = viewport.width;
          pageHeight = viewport.height;
        } catch (e) {
          showToast(`ページ ${pageIndex + 1} のサイズ取得に失敗しました。OCRを実行できません。`, true);
          return;
        }
      }

      // pdfCanvas からクロップ画像を生成
      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = sw;
      cropCanvas.height = sh;
      const ctx = cropCanvas.getContext('2d')!;
      ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

      const blob = await new Promise<Blob>((res) => cropCanvas.toBlob((b) => res(b!), 'image/png'));
      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      cropCanvas.width = 0;
      cropCanvas.height = 0;

      const scale = zoom / 100;
      // #285 D案: bytes を直接 Rust に渡す。Tauri fs-scope を経由しないため
      // Windows UNC verbatim prefix (\\?\) によるスコープ不一致が発生しない。
      // クロップ画像は zoom 済みピクセルなので renderScale として zoom / 100 を渡す。
      // pageWidth/pageHeight はクロップ前のページ全体サイズ（座標変換に使われる）。
      // PCT-101: Array.from(bytes) を廃止し ArrayBuffer を raw body で転送する。
      const settings = useOcrSettingsStore.getState();
      const ocrBody = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer
        : bytes.slice().buffer;
      const raw = await invoke<string>('run_ocr', ocrBody, {
        headers: {
          'x-page-width': String(pageWidth),
          'x-page-height': String(pageHeight),
          'x-render-scale': String(scale),
          'x-language-tag': settings.ocrLanguage ?? '',
        },
      });

      let parsed: import('../types').OcrResult;
      try {
        parsed = JSON.parse(raw) as import('../types').OcrResult;
      } catch (e) {
        showToast(`OCR結果のパースに失敗しました: ${e}`, true);
        return;
      }

      if (parsed.status === 'error') {
        showToast(`OCRエラー: ${parsed.message}`, true);
        return;
      }

      const ocrBlocks = parsed.blocks ?? [];
      if (ocrBlocks.length === 0) {
        showToast('範囲内にテキストが検出されませんでした。');
        return;
      }
      if (cancelTokenRef.current) return;
      if (!isCurrentDocument(capturedEpoch)) {
        showToast('OCR結果は破棄されました（別のPDFが開かれました）。', true);
        return;
      }

      // クロップ画像での bbox を元ページの viewport 座標に変換する。
      // OCR 結果の bbox はクロップ画像基準 (renderScale=zoom/100 でスケール済み・
      // rotated screen 空間) なので、元ページ viewport 座標に戻すには:
      //   1. crop 内ローカル座標 → 絶対 rotated screen 座標 (sx, sy を加算)
      //   2. #405: rotation !== 0 のときは rotated screen 空間 → bbox 空間へ逆変換
      //   3. bbox 空間 → scale (zoom/100) で割って viewport 座標に戻す
      const adjustedBlocks = ocrBlocks.map((b) => {
        const absRotatedRect = {
          x: b.bbox.x + sx,
          y: b.bbox.y + sy,
          width: b.bbox.width,
          height: b.bbox.height,
        };
        const bboxSpaceRect = rotParams
          ? rotatedScreenRectToBbox(absRotatedRect, rotParams)
          : absRotatedRect;
        return {
          ...b,
          bbox: {
            x: bboxSpaceRect.x / scale,
            y: bboxSpaceRect.y / scale,
            width: bboxSpaceRect.width / scale,
            height: bboxSpaceRect.height / scale,
          },
        };
      });

      const newBlocks = toTextBlocks(adjustedBlocks, settings);
      const currentPage = usePecoStore.getState().document?.pages.get(pageIndex);
      const existingBlocks = currentPage?.textBlocks ?? [];
      const mergedBlocks = [
        ...existingBlocks,
        ...newBlocks.map((b, i) => ({ ...b, order: existingBlocks.length + i })),
      ];

      usePecoStore.getState().updatePageData(pageIndex, {
        textBlocks: mergedBlocks,
        isDirty: true,
        isTextExtracted: true,
        ocrCleared: false,
      }, true);

      showToast(`範囲指定OCRが完了しました（${newBlocks.length}件追加）`);
    } catch (e) {
      console.error('[OCR] 範囲指定OCR エラー:', e);
      showToast(`範囲指定OCRに失敗しました: ${e}`, true);
    } finally {
      setOcrRunning(false);
    }
  };

  // hasDocument / currentPageIndex は Toolbar の disabled 制御用に返す
  return {
    isOcrRunning,
    ocrProgress,
    runOcrCurrentPage,
    runOcrAllPages,
    runOcrAllPagesSilent,
    runOcrRange,
    runOcrFolder,
    cancelOcr,
    checkAndPromptOcrZero,
    hasDocument,
    currentPageIndex,
    runOcrOnRegion,
  };
}
