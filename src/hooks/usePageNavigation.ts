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
//
// isLoadingPage は以下の 2 段階に分割されている:
//   - isLoadingPageMeta: viewport 寸法が取れるまで true (UI スピナー表示)
//   - isLoadingPageRender: 実 render() 完了まで true (usePdfRendering からコールバックで更新)
// 後方互換のため isLoadingPage = isLoadingPageMeta || isLoadingPageRender も返す。
export function usePageNavigation({
  document,
  currentPageIndex,
  showToast,
  triggerThumbnailLoad,
}: UsePageNavigationOptions) {
  const setCurrentPage = usePecoStore((s) => s.setCurrentPage);
  const updatePageData = usePecoStore((s) => s.updatePageData);
  const setCurrentPageProxy = usePecoStore((s) => s.setCurrentPageProxy);

  const [isLoadingPageMeta, setIsLoadingPageMeta] = useState(false);
  const [isLoadingPageRender, setIsLoadingPageRender] = useState(false);
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
    setIsLoadingPageMeta(true);
    // 新ページの render がまだ開始していない状態。後段で usePdfRendering が
    // コールバックで false にする。ここで先行 true にしておくことで
    // 「meta 完了 → render 進行中」という中間状態を App.tsx が検出できる。
    setIsLoadingPageRender(true);
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
      // 取得した PDFPageProxy は store に publish して usePdfRendering が
      // 二重 getCachedPageProxy を避けられるようにする。
      const qp = await getCachedPageProxy(doc.filePath, pageIdx);
      if (signal.aborted) return;
      const qv = qp.getViewport({ scale: 1.0 });

      // currentPageIndex がまだ pageIdx のうちに proxy を共有
      const liveState = usePecoStore.getState();
      if (liveState.document?.filePath === doc.filePath && liveState.currentPageIndex === pageIdx) {
        setCurrentPageProxy(doc.filePath, pageIdx, qp);
      }

      const pre = usePecoStore.getState().document?.pages.get(pageIdx);
      if (signal.aborted) return;
      if (!pre || pre.width === 0) {
        // isTextExtracted: false で明示的にプレースホルダとしてマーク。
        // textBlocks=[] だが本当に空かどうかはこのフラグで判別する。
        updatePageData(pageIdx, {
          pageIndex: pageIdx,
          width: qv.width,
          height: qv.height,
          textBlocks: [],
          isDirty: false,
          thumbnail: null,
          isTextExtracted: false,
        }, false);
      }

      // ページ寸法が確定した時点で meta ローディング解除
      // → PdfCanvas が即座にレンダリング開始。
      // render 完了までは isLoadingPageRender が true のまま。
      if (!signal.aborted) {
        setIsLoadingPageMeta(false);
      }

      // サムネイルWorkerのPDFロードをトリガー（冪等）
      triggerThumbnailLoad();

      // テキスト抽出はバックグラウンドで実行（レンダリングをブロックしない）
      // prefetch (±1/±2 ページの proxy 取得・loadPage) は pdfjs worker のタスクキューを
      // 占有して現在ページの描画/テキスト抽出を遅延させるため廃止。現在ページのみロードする。
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
            ? { ...pageData, textBlocks: existing!.textBlocks, isDirty: true, isTextExtracted: true }
            : { ...pageData, isTextExtracted: true };
          updatePageData(pageIdx, mergedData, false);
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
      setIsLoadingPageMeta(false);
      setIsLoadingPageRender(false);
    }
  }, [updatePageData, showToast, triggerThumbnailLoad, setCurrentPageProxy]);

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
    } else {
      // 既に viewport 寸法が取れているページでも、新ページに移った瞬間は
      // usePdfRendering の render() がまだ流れていないため、render 完了待ち状態
      // (isLoadingPageRender=true) を復元する。render 完了後に usePdfRendering が
      // markRenderComplete() でクリアする。
      // meta は既に揃っているので false。
      setIsLoadingPageMeta(false);
      setIsLoadingPageRender(true);

      // 既存ページの proxy も共有しておく (キャッシュヒットなら即時同期)
      void (async () => {
        try {
          const qp = await getCachedPageProxy(document.filePath, currentPageIndex);
          // レースチェック: 現在もこのページが選択されているか
          const live = usePecoStore.getState();
          if (live.document?.filePath === document.filePath && live.currentPageIndex === currentPageIndex) {
            setCurrentPageProxy(document.filePath, currentPageIndex, qp);
          }
        } catch {
          /* ignore: filePath switched など */
        }
      })();
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
  }, [document?.filePath, currentPageIndex, loadCurrentPage, setCurrentPageProxy]);

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

  // usePdfRendering から呼ばれる: render 完了時に isLoadingPageRender を解除する
  const markRenderComplete = useCallback(() => {
    setIsLoadingPageRender(false);
  }, []);

  const isLoadingPage = isLoadingPageMeta || isLoadingPageRender;

  return {
    isLoadingPage,
    isLoadingPageMeta,
    isLoadingPageRender,
    pageLoadError,
    pageInputValue,
    setPageInputValue,
    loadCurrentPage,
    handlePageInputCommit,
    handlePageInputKeyDown,
    markRenderComplete,
  };
}
