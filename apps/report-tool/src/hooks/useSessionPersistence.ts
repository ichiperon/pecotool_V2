import { useEffect, useRef } from "react";
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
 */
export function useSessionPersistence(storage?: SessionFileStorage): void {
  const storageRef = useRef<SessionFileStorage | null>(null);
  if (storageRef.current === null) {
    storageRef.current = storage ?? createSessionFileStorage();
  }

  useEffect(() => {
    const store = storageRef.current!;
    let timer: number | null = null;
    let disposed = false;

    const saveNow = async () => {
      const rs = useReportStore.getState();
      const ps = usePdfStore.getState();
      // 抽出データが無い状態は保存しない（reset 直後に有効なセッションを潰さない）
      if (!ps.filePath || rs.cells.size === 0) return;
      const json = serializeSession({
        pdfPath: ps.filePath,
        savedAt: new Date().toISOString(),
        rotation: ps.rotation,
        fields: rs.template.fields,
        cells: rs.cells,
        confidences: rs.confidences,
        edited: rs.edited,
        pageOffsets: rs.pageOffsets,
        excludedPages: rs.excludedPages,
      });
      await store.save(json);
    };

    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void saveNow();
      }, SESSION_AUTOSAVE_DEBOUNCE_MS);
    };

    /**
     * 復元オファー。PDF open 直後は同 tick で resetExtractedData が走るため、
     * setTimeout(0) で 1 tick 譲ってから「作業が空か」を判定する。
     */
    const offerRestore = (openedPath: string) => {
      window.setTimeout(() => {
        void (async () => {
          if (disposed) return;
          // 既に作業がある（復元不要）なら聞かない
          if (useReportStore.getState().cells.size > 0) return;
          const loaded = await store.load();
          if (!loaded.ok) return;
          const decoded = deserializeSession(loaded.json);
          if (!decoded.ok) return;
          const s = decoded.session;
          if (s.pdfPath !== openedPath) return; // 別 PDF のセッションは適用しない
          if (usePdfStore.getState().filePath !== openedPath) return; // その後に差し替わった

          const savedLabel = new Date(s.savedAt).toLocaleString();
          const ok = window.confirm(
            `この PDF の前回の作業（${savedLabel} 保存）が残っています。続きから再開しますか？\n（いいえ＝新規に始める。保存済みセッションは次の作業で上書きされます）`
          );
          if (!ok) return;

          useReportStore.setState({
            template: { fields: s.fields },
            cells: s.cells,
            confidences: s.confidences,
            edited: s.edited,
            pageOffsets: s.pageOffsets,
            excludedPages: s.excludedPages,
            selectedFieldId: null,
            past: [],
            future: [],
            lastUndoableTag: null,
          });
          usePdfStore.setState({ rotation: s.rotation as 0 | 90 | 180 | 270 });
        })();
      }, 0);
    };

    const unsubReport = useReportStore.subscribe(() => schedule());
    const unsubPdf = usePdfStore.subscribe((state, prev) => {
      if (state.filePath && state.filePath !== prev.filePath) {
        offerRestore(state.filePath);
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
}
