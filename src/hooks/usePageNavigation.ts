import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePecoStore } from '../store/pecoStore';
import {
  loadPecoToolBBoxMeta,
  loadPage,
  getSharedPdfProxy,
  getCachedPageProxy,
} from '../utils/pdfLoader';
import type { PecoDocument, BoundingBox } from '../types';

interface UsePageNavigationOptions {
  document: PecoDocument | null | undefined;
  currentPageIndex: number;
  showToast: (message: string, isError?: boolean) => void;
  triggerThumbnailLoad: () => void;
}

// ページ読み込み・プリフェッチ・ページ番号入力を担当
// AbortController ベースのレース修正 (Tier 1-D) を内包
export function usePageNavigation({
  document,
  currentPageIndex,
  showToast,
  triggerThumbnailLoad,
}: UsePageNavigationOptions) {
  const setCurrentPage = usePecoStore((s) => s.setCurrentPage);
  const updatePageData = usePecoStore((s) => s.updatePageData);

  const [isLoadingPage, setIsLoadingPage] = useState(false);
  const [pageLoadError, setPageLoadError] = useState<number | null>(null);
  const [pageInputValue, setPageInputValue] = useState<string | null>(null);

  const currentLoadAbortRef = useRef<AbortController | null>(null);
  const bboxMetaRef = useRef<Record<string, Array<{
    bbox: BoundingBox;
    writingMode: string;
    order: number;
    text: string;
  }>> | null | undefined>(undefined);

  const loadCurrentPage = useCallback(async (pageIdx: number) => {
    // 前回の読み込みをキャンセルし、新しい AbortController を発行
    currentLoadAbortRef.current?.abort();
    const controller = new AbortController();
    currentLoadAbortRef.current = controller;
    const signal = controller.signal;

    const doc = usePecoStore.getState().document;
    if (!doc) return;
    setIsLoadingPage(true);
    setPageLoadError(null);
    try {
      const pdf = await getSharedPdfProxy(doc.filePath);

      if (signal.aborted) return;

      // bboxMetaが未取得の場合、1ページ目表示をブロックせずバックグラウンドで取得する。
      // 取得した meta は bboxMetaRef.current に保持し、以降の loadPage 呼び出し
      // (行 107, 151) で利用する。
      // 注意: 200 ページ級 PDF で全ページ loadPage を forEach で発火すると
      //       getTextContent() が単一 pdfjs worker に 200 件同時投入され、
      //       現在ページ含む全 getTextContent が順番待ちで詰まる。
      //       そのため先行一括ロードは行わず、実際にそのページを表示・プリフェッチ
      //       する時 (ナビゲーション時の ±1/±2 プリフェッチ経由) に限定する。
      if (bboxMetaRef.current === undefined) {
        bboxMetaRef.current = null;
        loadPecoToolBBoxMeta(pdf).then((meta) => {
          bboxMetaRef.current = meta;
        }).catch(() => {});
      }

      // ページ寸法を先行取得してfitToScreenを即時発火（getTextContent待ちをなくす）
      const qp = await getCachedPageProxy(doc.filePath, pageIdx);
      if (signal.aborted) return;
      const qv = qp.getViewport({ scale: 1.0 });
      const pre = usePecoStore.getState().document?.pages.get(pageIdx);
      if (signal.aborted) return;
      if (!pre || pre.width === 0) {
        updatePageData(pageIdx, {
          pageIndex: pageIdx,
          width: qv.width,
          height: qv.height,
          textBlocks: [],
          isDirty: false,
          thumbnail: null,
        }, false);
      }

      // ページ寸法が確定した時点でローディング解除 → PdfCanvas が即座にレンダリング開始
      if (!signal.aborted) {
        setIsLoadingPage(false);
      }

      // サムネイルWorkerのPDFロードをトリガー（冪等）
      triggerThumbnailLoad();

      // テキスト抽出はバックグラウンドで実行（レンダリングをブロックしない）
      loadPage(pdf, pageIdx, doc.filePath, bboxMetaRef.current, doc.mtime)
        .then((pageData) => {
          if (signal.aborted) return;
          // ファイル切替チェック（ページ切替は許容: テキストデータは常に保存する）
          const currentDoc = usePecoStore.getState().document;
          if (!currentDoc || currentDoc.filePath !== doc.filePath) return;
          const existing = currentDoc.pages.get(pageIdx);
          // isDirty だけで保持すると、clearOcrAllPages の stub や width===0 の未ロード
          // ダミーが空 textBlocks を抱えたまま loadPage の実データを破棄してしまう。
          // 実ユーザー編集は textBlocks が非空である前提のため、ここで絞る。
          const hasUserEdits = !!existing && existing.isDirty && existing.textBlocks.length > 0;
          const mergedData = hasUserEdits
            ? { ...pageData, textBlocks: existing!.textBlocks, isDirty: true }
            : pageData;
          updatePageData(pageIdx, mergedData, false);

          // ページプロキシ＋データを段階的にプリフェッチ（Worker飽和回避）
          // Step 1: ±1ページのプロキシのみ即座にキャッシュ
          for (const offset of [1, -1]) {
            if (signal.aborted) return;
            const i = pageIdx + offset;
            if (i >= 0 && i < doc.totalPages) {
              getCachedPageProxy(doc.filePath, i).catch(() => {});
            }
          }
          // Step 2: idle時に±3プロキシ + ±2ページデータをプリフェッチ
          const idleCb = () => {
            if (signal.aborted) return;
            const s = usePecoStore.getState();
            if (!s.document || s.document.filePath !== doc.filePath) return;
            for (let offset = -3; offset <= 3; offset++) {
              if (signal.aborted) return;
              const i = pageIdx + offset;
              if (i >= 0 && i < doc.totalPages && Math.abs(offset) > 1) {
                getCachedPageProxy(doc.filePath, i).catch(() => {});
              }
            }
            // ±2ページデータのプリフェッチ（未ロードのみ）
            for (const offset of [1, -1, 2, -2]) {
              if (signal.aborted) return;
              const i = pageIdx + offset;
              if (i < 0 || i >= doc.totalPages) continue;
              const existing = s.document?.pages.get(i);
              if (existing && existing.width > 0) continue;
              loadPage(pdf, i, doc.filePath, bboxMetaRef.current, doc.mtime)
                .then((pd) => {
                  if (signal.aborted) return;
                  const st = usePecoStore.getState();
                  if (st.document?.filePath !== doc.filePath) return;
                  const ex = st.document.pages.get(i);
                  const exHasUserEdits = !!ex && ex.isDirty && ex.textBlocks.length > 0;
                  const merged = exHasUserEdits ? { ...pd, textBlocks: ex!.textBlocks, isDirty: true } : pd;
                  if (!ex || ex.width === 0) updatePageData(i, merged, false);
                })
                .catch(() => {});
            }
          };
          if ('requestIdleCallback' in window) {
            requestIdleCallback(idleCb);
          } else {
            setTimeout(idleCb, 200);
          }
        })
        .catch((err) => {
          if (signal.aborted) return;
          console.error(`[loadCurrentPage] text extraction failed for page ${pageIdx}:`, err);
        });
    } catch (err: any) {
      if (signal.aborted) return;
      console.error(`[loadCurrentPage] failed for page ${pageIdx}:`, err);
      showToast(`ページ ${pageIdx + 1} の読み込みに失敗しました: ${err}`, true);
      setPageLoadError(pageIdx);
      triggerThumbnailLoad();
      setIsLoadingPage(false);
    }
  }, [updatePageData, showToast, triggerThumbnailLoad]);

  // ファイルが変わったときにbboxMetaキャッシュをリセット
  const prevFilePathRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (document?.filePath !== prevFilePathRef.current) {
      bboxMetaRef.current = undefined;
      prevFilePathRef.current = document?.filePath;
    }
  }, [document?.filePath]);

  useEffect(() => {
    if (!document) return;
    const pageData = document.pages.get(currentPageIndex);
    // 未ロード、またはOCR全消去で作られたダミー（width===0）の場合はロードする
    if (!pageData || pageData.width === 0) {
      loadCurrentPage(currentPageIndex);
    }
    return () => {
      // ページ切替・アンマウント時は進行中ロードを中止
      currentLoadAbortRef.current?.abort();
    };
    // document?.pages を依存から除外する理由:
    // updatePageData が set() で新しい Map を生成する度に
    // この effect が再実行され、cleanup の abort() が自分自身のロードを
    // 毎回キャンセルするため、実データが updatePageData に到達しない。
    // ページ読み込みトリガーは filePath と currentPageIndex の変化で十分。
  }, [document?.filePath, currentPageIndex, loadCurrentPage]);

  const handlePageInputCommit = useCallback(() => {
    if (pageInputValue !== null && document) {
      const pageNum = parseInt(pageInputValue, 10);
      if (!isNaN(pageNum) && pageNum >= 1 && pageNum <= document.totalPages) {
        setCurrentPage(pageNum - 1);
      }
    }
    setPageInputValue(null);
  }, [pageInputValue, document, setCurrentPage]);

  const handlePageInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      setPageInputValue(null);
      e.currentTarget.blur();
    }
  }, []);

  return {
    isLoadingPage,
    pageLoadError,
    pageInputValue,
    setPageInputValue,
    loadCurrentPage,
    handlePageInputCommit,
    handlePageInputKeyDown,
  };
}
