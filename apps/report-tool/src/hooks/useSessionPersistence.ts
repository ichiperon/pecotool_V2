import { useCallback, useEffect, useRef } from "react";
import { useReportStore } from "../store/reportStore";
import { usePdfStore } from "../store/pdfStore";
import { serializeSession, deserializeSession } from "../logic/sessionCodec";
import { createSessionFileStorage, type SessionFileStorage } from "../lib/sessionFileStorage";

/** 自動保存のデバウンス間隔 (ms)。編集の連打で書込みが暴れないための猶予。 */
export const SESSION_AUTOSAVE_DEBOUNCE_MS = 2000;

/**
 * 作業セッションの自動保存と「前回の続きから再開」。
 *
 * - 自動保存: reportStore / pdfStore の変化をデバウンスし、抽出データ（cells 非空）が
 *   ある間だけ %APPDATA%/session/current.json へ保存する。cells 空では保存しない
 *   （PDF 開き直し直後の reset で直前セッションを空で潰さないためのガード）。
 * - 復元: PDF を開いたとき、保存済みセッションの pdfPath が一致し、かつ現在の
 *   作業が空なら確認ダイアログを出して store 一式（欄・cells・信頼度・手修正・
 *   オフセット・除外・回転）を復元する。undo 履歴は復元しない（新しい境界）。
 *
 * @param storage テスト用の差し替え口。省略時は Tauri invoke ベースの既定実装。
 * @returns flushNow: デバウンスを待たず即時保存する。クローズ前フラッシュ用
 *   （保存に成功したら true。抽出データなし・保存失敗・ランタイム外は false）。
 */
export function useSessionPersistence(storage?: SessionFileStorage): {
  flushNow: () => Promise<boolean>;
} {
  const storageRef = useRef<SessionFileStorage | null>(null);
  if (storageRef.current === null) {
    storageRef.current = storage ?? createSessionFileStorage();
  }
  // effect 内で確定する即時保存関数への安定参照（クローズガードから呼ぶ）
  const flushRef = useRef<() => Promise<boolean>>(async () => false);
  const flushNow = useCallback(() => flushRef.current(), []);

  useEffect(() => {
    const store = storageRef.current!;
    let timer: number | null = null;
    let disposed = false;
    let reportRevision = 0;

    const saveNow = async (): Promise<boolean> => {
      const rs = useReportStore.getState();
      const ps = usePdfStore.getState();
      // 抽出データが無い状態は保存しない（reset 直後に有効なセッションを潰さない）。
      // pdfFingerprint 未確定（PDF 未読込 or 読込途中）でも保存しない
      // （#446: fingerprint 無しのセッションは v2 スキーマで復元不可能になるため）。
      if (!ps.filePath || !ps.pdfFingerprint || rs.cells.size === 0) return false;
      const json = serializeSession({
        pdfPath: ps.filePath,
        pdfFingerprint: ps.pdfFingerprint,
        savedAt: new Date().toISOString(),
        rotation: ps.rotation,
        fields: rs.template.fields,
        cells: rs.cells,
        confidences: rs.confidences,
        edited: rs.edited,
        pageOffsets: rs.pageOffsets,
        excludedPages: rs.excludedPages,
        diagnostics: {
          failedPages: rs.failedPages,
          layoutMismatchPages: rs.layoutMismatchPages,
          layoutBasePage: rs.layoutBasePage,
        },
      });
      const result = await store.save(json);
      return result.ok;
    };

    // single-flight + 1件コアレス: デバウンス発火中の save と flushNow の save が
    // 並走すると、Rust 側は temp を一意名で分離していても最終 rename 先
    // （current.json）は単一スロットのため、後勝ちの内容が読めなくなる懸念がある
    // （#450 frontend）。実行中の save があれば新規呼び出しは追い打ちフラグだけ
    // 立てて既存の実行に相乗りし、完了後に最新 state でもう1回だけ実行する。
    let inFlight: Promise<boolean> | null = null;
    let pendingRerun = false;

    const runSingleFlight = (): Promise<boolean> => {
      if (inFlight) {
        pendingRerun = true;
        return inFlight;
      }
      const run = (async (): Promise<boolean> => {
        let result = await saveNow();
        while (pendingRerun) {
          pendingRerun = false;
          result = await saveNow();
        }
        return result;
      })();
      inFlight = run;
      void run.finally(() => {
        if (inFlight === run) inFlight = null;
      });
      return run;
    };

    // クローズ前フラッシュ: 保留中のデバウンスを破棄し、実行中の save があれば
    // 完了を待ってから、最新 state で最終保存を実行する（並走させない）。
    flushRef.current = async () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      while (inFlight) {
        await inFlight.catch(() => {});
      }
      return runSingleFlight();
    };

    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void runSingleFlight();
      }, SESSION_AUTOSAVE_DEBOUNCE_MS);
    };

    /**
     * 復元オファー。PDF open 直後は同 tick で resetExtractedData が走るため、
     * setTimeout(0) で 1 tick 譲ってから「作業が空か」を判定する。
     *
     * fingerprint 比較について（#446）: PdfViewer.handleOpenPdf は bytes から
     * フィンガープリントを計算し終えてから setPdf を呼ぶ（filePath と同一の
     * set() で pdfFingerprint も同時に確定する）。そのため、この offerRestore が
     * 呼ばれる時点（pdfStore.filePath の変化を検知した後）では
     * usePdfStore.getState().pdfFingerprint は既に確定済みであり、
     * 「fingerprint 未確定のまま比較してしまう」競合は設計上発生しない
     * （setPdf 呼び出し自体が fingerprint 確定後まで待たされるため）。
     */
    const offerRestore = (openedPath: string, openedGeneration: number) => {
      window.setTimeout(() => {
        void (async () => {
          if (disposed) return;
          // 既に作業がある（復元不要）なら聞かない
          if (useReportStore.getState().cells.size > 0) return;
          const startedReportRevision = reportRevision;
          const startedPdfState = usePdfStore.getState();
          if (
            openedGeneration !== startedPdfState.loadGeneration ||
            startedPdfState.filePath !== openedPath ||
            !startedPdfState.pdfFingerprint
          ) {
            return;
          }
          const loaded = await store.load();
          // レビュー差し戻し (#459・マリン指摘): store.load() の await 中に
          // effect がアンマウントされていたら、以降の confirm ダイアログ表示まで
          // 進めない。この disposed チェックが無いと、アンマウント後に「前回の
          // 続きから再開しますか？」の確認ダイアログだけが遅れて出てしまう。
          if (disposed) return;
          if (!loaded.ok) return;
          const decoded = deserializeSession(loaded.json);
          if (!decoded.ok) return;
          const s = decoded.session;
          if (s.pdfPath !== openedPath) return; // 別 PDF のセッションは適用しない
          const currentPdfState = usePdfStore.getState();
          if (
            openedGeneration !== currentPdfState.loadGeneration ||
            currentPdfState.filePath !== openedPath ||
            currentPdfState.pdfFingerprint !== startedPdfState.pdfFingerprint ||
            reportRevision !== startedReportRevision ||
            useReportStore.getState().cells.size > 0
          ) {
            return;
          }
          // パスが同じでも中身が変わっていれば別ファイル扱い（誤復元防止）
          if (s.pdfFingerprint !== currentPdfState.pdfFingerprint) return;

          const savedLabel = new Date(s.savedAt).toLocaleString();
          const ok = window.confirm(
            `この PDF の前回の作業（${savedLabel} 保存）が残っています。続きから再開しますか？\n（いいえ＝新規に始める。保存済みセッションは次の作業で上書きされます）`
          );
          if (!ok) return;

          // confirm 表示中を含め、復元開始後に新しい OCR・編集・PDF 再読込が
          // 発生していたら旧セッションを適用しない。
          const applyPdfState = usePdfStore.getState();
          if (
            disposed ||
            openedGeneration !== applyPdfState.loadGeneration ||
            applyPdfState.filePath !== openedPath ||
            applyPdfState.pdfFingerprint !== startedPdfState.pdfFingerprint ||
            reportRevision !== startedReportRevision ||
            useReportStore.getState().cells.size > 0
          ) {
            return;
          }

          useReportStore.setState({
            template: { fields: s.fields },
            cells: s.cells,
            confidences: s.confidences,
            edited: s.edited,
            pageOffsets: s.pageOffsets,
            excludedPages: s.excludedPages,
            failedPages: s.diagnostics.failedPages,
            layoutMismatchPages: s.diagnostics.layoutMismatchPages,
            layoutBasePage: s.diagnostics.layoutBasePage,
            selectedFieldId: null,
            past: [],
            future: [],
            lastUndoableTag: null,
          });
          usePdfStore.setState({ rotation: s.rotation as 0 | 90 | 180 | 270 });
        })();
      }, 0);
    };

    const unsubReport = useReportStore.subscribe(() => {
      reportRevision++;
      schedule();
    });
    const unsubPdf = usePdfStore.subscribe((state, prev) => {
      if (state.filePath && state.loadGeneration !== prev.loadGeneration) {
        offerRestore(state.filePath, state.loadGeneration);
      }
      // 回転などの変化も保存対象
      schedule();
    });

    return () => {
      disposed = true;
      unsubReport();
      unsubPdf();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  return { flushNow };
}
