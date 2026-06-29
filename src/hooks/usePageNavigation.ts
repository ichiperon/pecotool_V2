import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePecoStore } from '../store/pecoStore';
import { useInfraStore } from '../store/infraStore';
import {
  loadPecoToolBBoxMeta,
  loadPage,
  getSharedPdfProxy,
  getCachedPageProxy,
} from '../utils/pdfLoader';
import { perf } from '../utils/perfLogger';
import { displayToSourcePageIndex } from '../utils/pageOrder';
import type { BoundingBox } from '../types';

type BBoxMeta = Record<string, Array<{
  bbox: BoundingBox;
  writingMode: string;
  order: number;
  text: string;
}>>;

interface UsePageNavigationOptions {
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
  currentPageIndex,
  showToast,
  triggerThumbnailLoad,
}: UsePageNavigationOptions) {
  const setCurrentPage = usePecoStore((s) => s.setCurrentPage);
  const updatePageData = usePecoStore((s) => s.updatePageData);
  const setCurrentPageProxy = useInfraStore((s) => s.setCurrentPageProxy);
  // document 全体ではなく primitives のみ購読
  // (updatePageData 毎の document 参照差し替えで再レンダが起きないようにするため)
  const filePath = usePecoStore((s) => s.document?.filePath);
  // #102: setDocument のたびに +1 される単調増加カウンタ。同一 filePath の再読込
  // (F5 / Ctrl+O で同じファイルを開き直す等) でも document identity が変わったことを
  // 検出するために購読する。updatePageData による document 再生成では変化しない。
  const documentEpoch = useInfraStore((s) => s.documentEpoch);
  const documentMtime = usePecoStore((s) => s.document?.mtime);
  const totalPages = usePecoStore((s) => s.document?.totalPages);
  const currentSourcePageIndex = usePecoStore((s) => displayToSourcePageIndex(s.pageOrder, currentPageIndex));
  // 現在ページの width のみ購読 (未ロード判定用。textBlocks 等には反応しない)
  const currentPageWidth = usePecoStore((s) => s.document?.pages.get(currentPageIndex)?.width);
  const currentPageExists = usePecoStore((s) => s.document?.pages.has(currentPageIndex) ?? false);

  const [isLoadingPageMeta, setIsLoadingPageMeta] = useState(false);
  const [isLoadingPageRender, setIsLoadingPageRender] = useState(false);
  const [pageLoadError, setPageLoadError] = useState<number | null>(null);
  const [pageInputValue, setPageInputValue] = useState<string | null>(null);

  const currentLoadAbortRef = useRef<AbortController | null>(null);
  const bboxMetaRef = useRef<BBoxMeta | null | undefined>(undefined);

  const loadCurrentPage = useCallback(async (
    pageIdx: number,
    owner?: { controller: AbortController | null },
  ) => {
    perf.mark('nav.loadEntry', { page: pageIdx });
    // 前回の読み込みをキャンセルし、新しい AbortController を発行
    currentLoadAbortRef.current?.abort();
    const controller = new AbortController();
    currentLoadAbortRef.current = controller;
    if (owner) owner.controller = controller;
    const signal = controller.signal;

    const stateAtStart = usePecoStore.getState();
    const doc = stateAtStart.document;
    const sourcePageIndex = displayToSourcePageIndex(stateAtStart.pageOrder, pageIdx);
    const capturedDocumentEpoch = useInfraStore.getState().documentEpoch;
    if (!doc) return;
    setIsLoadingPageMeta(true);
    // 新ページの render がまだ開始していない状態。後段で usePdfRendering が
    // コールバックで false にする。ここで先行 true にしておくことで
    // 「meta 完了 → render 進行中」という中間状態を App.tsx が検出できる。
    setIsLoadingPageRender(true);
    setPageLoadError(null);
    try {
      perf.mark('nav.sharedStart', { page: pageIdx });
      const pdf = await getSharedPdfProxy(doc.filePath);
      perf.mark('nav.sharedDone', { page: pageIdx });

      if (signal.aborted) return;

      // bboxMeta は loadPage の text/bbox 復元経路に必須。await して確実に解決してから
      // loadPage を呼ぶ (#99 主因対策)。
      //
      // 旧実装は fire-and-forget で bboxMetaRef を後埋めしていたため、初回ナビゲーション時
      // bboxMeta=null のまま loadPage が走り、pdfjs textItems から bbox を再計算する fallback
      // 経路 (pdfTextExtractor.ts の ascent=thickness*1.16) を取った。結果として保存時の
      // viewport-space bbox とは別の値が描画され、再読込で bbox.height * 0.36 程度の上方ずれが
      // 発生していた。さらに IDB キャッシュにこの誤った bbox が固着し、以降の再読込でも
      // 同じズレが残る固着問題があった。
      //
      // 注意: 200 ページ級 PDF で全ページ loadPage を forEach で発火すると getTextContent()
      //       が単一 pdfjs worker に同時投入されて詰まる。そのため bboxMeta 取得後の先行
      //       一括ロードは行わず、実際にそのページを表示する時のみ loadPage する。
      //       meta 取得自体は metadata stream 1 回読みのみで getTextContent には介入しない。
      if (bboxMetaRef.current === undefined) {
        let nextBBoxMeta: BBoxMeta | null;
        try {
          nextBBoxMeta = await loadPecoToolBBoxMeta(pdf, {
            loadBytes: async () => {
              const { readFile } = await import('@tauri-apps/plugin-fs');
              return readFile(doc.filePath);
            },
            filePath: doc.filePath,
            mtime: doc.mtime,
            // #392: ファイルを開いて最初に meta を読むのはこの経路（ページ表示）。ここで
            // undecodable を検出して警告フラグを立てる（cache-hit でも再通知される）。
            onUndecodable: () => useInfraStore.getState().setBboxMetaUnreadable(true),
          });
        } catch {
          nextBBoxMeta = null;
        }
        const liveState = usePecoStore.getState();
        const liveInfra = useInfraStore.getState();
        const liveDoc = liveState.document;
        if (
          signal.aborted ||
          liveInfra.documentEpoch !== capturedDocumentEpoch ||
          !liveDoc ||
          liveDoc.filePath !== doc.filePath ||
          liveDoc.mtime !== doc.mtime
        ) return;
        bboxMetaRef.current = nextBBoxMeta;
      }

      // ページ寸法を先行取得してfitToScreenを即時発火（getTextContent待ちをなくす）
      // 取得した PDFPageProxy は store に publish して usePdfRendering が
      // 二重 getCachedPageProxy を避けられるようにする。
      perf.mark('nav.pageProxyStart', { page: pageIdx });
      const qp = await getCachedPageProxy(doc.filePath, sourcePageIndex);
      perf.mark('nav.pageProxyDone', { page: pageIdx });
      if (signal.aborted) return;
      const qv = qp.getViewport({ scale: 1.0 });
      perf.mark('nav.viewport', { page: pageIdx, w: Math.round(qv.width), h: Math.round(qv.height) });

      // currentPageIndex がまだ pageIdx のうちに proxy を共有
      const liveState2 = usePecoStore.getState();
      const liveInfra2 = useInfraStore.getState();
      if (
        liveState2.document?.filePath === doc.filePath &&
        liveInfra2.documentEpoch === capturedDocumentEpoch &&
        liveState2.currentPageIndex === pageIdx &&
        displayToSourcePageIndex(liveState2.pageOrder, pageIdx) === sourcePageIndex
      ) {
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
        perf.mark('nav.metaDone', { page: pageIdx });
        setIsLoadingPageMeta(false);
      }

      // サムネイルWorkerのPDFロードをトリガー（冪等）
      triggerThumbnailLoad();

      // テキスト抽出はバックグラウンドで実行（レンダリングをブロックしない）
      // prefetch (±1/±2 ページの proxy 取得・loadPage) は pdfjs worker のタスクキューを
      // 占有して現在ページの描画/テキスト抽出を遅延させるため廃止。現在ページのみロードする。
      perf.mark('text.loadStart', { page: pageIdx });
      loadPage(pdf, sourcePageIndex, doc.filePath, bboxMetaRef.current, doc.mtime, { displayPageIndex: pageIdx })
        .then((pageData) => {
          if (signal.aborted) return;
          // ファイル切替チェック（ページ切替は許容: テキストデータは常に保存する）
          const currentState = usePecoStore.getState();
          const currentDoc = currentState.document;
          if (useInfraStore.getState().documentEpoch !== capturedDocumentEpoch) return;
          if (!currentDoc || currentDoc.filePath !== doc.filePath) return;
          if (displayToSourcePageIndex(currentState.pageOrder, pageIdx) !== sourcePageIndex) return;
          const existing = currentDoc.pages.get(pageIdx);
          // isDirty だけで保持すると、clearOcrAllPages の stub や width===0 の未ロード
          // ダミーが空 textBlocks を抱えたまま loadPage の実データを破棄してしまう。
          // 実ユーザー編集は textBlocks が非空である前提のため、ここで絞る。
          const hasUserEdits = !!existing && existing.isDirty && (existing.textBlocks.length > 0 || existing.ocrCleared === true);
          const mergedData = hasUserEdits
            ? { ...pageData, pageIndex: pageIdx, textBlocks: existing!.textBlocks, isDirty: true, isTextExtracted: true }
            : { ...pageData, pageIndex: pageIdx, isTextExtracted: true };
          perf.mark('text.updateStoreStart', { page: pageIdx, blocks: mergedData.textBlocks?.length ?? 0 });
          updatePageData(pageIdx, mergedData, false);
          perf.mark('text.updateStoreDone', { page: pageIdx });
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

  // ドキュメント identity が変わったときに bboxMeta キャッシュをリセット。
  // filePath だけでなく mtime / documentEpoch も見るのは、同じパスのファイルを
  // 開き直した (F5 / Ctrl+O) ケースで前ドキュメントの bboxMeta を持ち越さないため。
  const prevDocIdentityRef = useRef<{ filePath?: string; mtime?: number; epoch?: number }>({});
  useEffect(() => {
    const prev = prevDocIdentityRef.current;
    if (filePath !== prev.filePath || documentMtime !== prev.mtime || documentEpoch !== prev.epoch) {
      bboxMetaRef.current = undefined;
      prevDocIdentityRef.current = { filePath, mtime: documentMtime, epoch: documentEpoch };
    }
  }, [filePath, documentMtime, documentEpoch]);

  useEffect(() => {
    if (!filePath) return;
    const loadOwner = { controller: null as AbortController | null };
    // issue #141: getCachedPageProxy の await 後に effect が cleanup された場合
    // setCurrentPageProxy を呼ばないためのフラグ。store の live チェックでも
    // 同一 (filePath, epoch, pageIndex) のまま別 effect run に切り替わる例
    // (例: 同ページに対する再ロード) を捕捉できないため、cancelled で確実に止める。
    let cancelled = false;
    // 未ロード、またはOCR全消去で作られたダミー（width===0）の場合はロードする
    if (!currentPageExists || currentPageWidth === 0) {
      loadCurrentPage(currentPageIndex, loadOwner);
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
          const qp = await getCachedPageProxy(filePath, currentSourcePageIndex);
          if (cancelled) return;
          // レースチェック: 現在もこのページが選択されているか
          const live = usePecoStore.getState();
          const liveInfra = useInfraStore.getState();
          if (
            live.document?.filePath === filePath &&
            liveInfra.documentEpoch === documentEpoch &&
            live.currentPageIndex === currentPageIndex &&
            displayToSourcePageIndex(live.pageOrder, currentPageIndex) === currentSourcePageIndex
          ) {
            setCurrentPageProxy(filePath, currentPageIndex, qp);
          }
        } catch {
          /* ignore: filePath switched など */
        }
      })();
    }
    return () => {
      cancelled = true;
      // この effect run が開始したロードだけを中止する。
      if (loadOwner.controller && currentLoadAbortRef.current === loadOwner.controller) {
        loadOwner.controller.abort();
      }
    };
    // currentPageWidth/currentPageExists は loadCurrentPage 後の
    // updatePageData で変化するが、依存に含めると「ロード直後に effect 再実行 →
    // cleanup で自分の abort」のループになる。filePath + documentEpoch +
    // currentPageIndex の変化トリガーで十分 (ロード判定は最初の run だけで良い)。
    // documentEpoch を含めることで、同一 filePath/currentPageIndex でも document が
    // 差し替わった (再読込) 場合に loadCurrentPage を再発火できる。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, documentEpoch, currentPageIndex, currentSourcePageIndex, loadCurrentPage, setCurrentPageProxy]);

  const handlePageInputCommit = useCallback(() => {
    if (pageInputValue !== null && filePath && totalPages) {
      const normalizedPageInput = pageInputValue.trim();
      const pageNum = Number(normalizedPageInput);
      if (/^\d+$/.test(normalizedPageInput) && pageNum >= 1 && pageNum <= totalPages) {
        setCurrentPage(pageNum - 1);
      }
    }
    setPageInputValue(null);
  }, [pageInputValue, filePath, totalPages, setCurrentPage]);

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
