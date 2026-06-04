import { create } from 'zustand';
import { PecoDocument, PageData, Action, TextBlock, RotatePagesAction } from '../types';
import { useViewerStore } from './viewerStore';
import { useInfraStore } from './infraStore';
import {
  saveTemporaryPageDataBatch,
  clearTemporaryChanges,
  getAllTemporaryPageData,
  deleteTemporaryPageKeys,
  renameTemporaryPageKeys,
} from '../utils/pdfLoader';
import { perf } from '../utils/perfLogger';

// 進行中のLRU退避IDB書き込みPromiseを追跡する。
// 保存処理はこれらが完了してからIDBを読み込む必要がある。
const pendingIdbSaves: Set<Promise<void>> = new Set();
let ocrClearGeneration = 0;

/** 全てのLRU退避IDB書き込みが完了するまで待機する */
export function waitForPendingIdbSaves(): Promise<void> {
  if (pendingIdbSaves.size === 0) return Promise.resolve();
  return Promise.all(Array.from(pendingIdbSaves)).then(() => {});
}

export function trackPendingIdbWork(work: Promise<void>): void {
  const tracked: Promise<void> = work.finally(() => {
    pendingIdbSaves.delete(tracked);
  });
  pendingIdbSaves.add(tracked);
}

function clearedOcrData(pageIndex: number, data: Partial<PageData> = {}): Partial<PageData> {
  return {
    ...data,
    pageIndex,
    textBlocks: [],
    isDirty: true,
    isTextExtracted: true,
    ocrCleared: true,
  };
}

function clearedOcrPage(pageIndex: number, page: PageData): PageData {
  return {
    ...page,
    pageIndex,
    textBlocks: [],
    isDirty: true,
    isTextExtracted: true,
    ocrCleared: true,
  };
}

/**
 * IDB 一時データへの書き込みを pendingIdbSaves に登録した上で発火する。
 * undo/redo など、メモリ Map を変更したあと LRU 退避済み IDB エントリと
 * 同期する用途で使う共通ヘルパ。
 * lastIdbError は infraStore に委譲する。
 */
function schedulePendingIdbWrite(
  entries: Array<{ filePath: string; pageIndex: number; data: Partial<PageData> }>,
  options?: { afterPending?: boolean },
): void {
  if (entries.length === 0) return;
  const infra = useInfraStore.getState();
  const pendingBeforeWrite = options?.afterPending ? waitForPendingIdbSaves() : Promise.resolve();
  const work = pendingBeforeWrite
    .then(() => saveTemporaryPageDataBatch(entries))
    .then(() => {
      useInfraStore.getState().clearLastIdbErrorIfSet();
    })
    .catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error('[Store] schedulePendingIdbWrite 失敗:', err);
      useInfraStore.getState().setLastIdbError(err);
    });
  void infra; // suppress unused variable warning
  trackPendingIdbWork(work);
}

function scheduleClearOcrAllPagesIdbWrite(filePath: string, totalPages: number): void {
  const pendingBeforeWrite = waitForPendingIdbSaves();
  const work = pendingBeforeWrite
    .then(async () => {
      const idbPages = await getAllTemporaryPageData(filePath);
      const currentDocument = usePecoStore.getState().document;
      const livePages = currentDocument?.filePath === filePath ? currentDocument.pages : undefined;
      const entries = Array.from({ length: totalPages }, (_, idx) => ({
        filePath,
        pageIndex: idx,
        data: livePages?.has(idx)
          ? clearedOcrPage(idx, livePages.get(idx)!)
          : clearedOcrData(idx, idbPages.get(idx) ?? {}),
      }));
      await saveTemporaryPageDataBatch(entries);
    })
    .then(() => {
      useInfraStore.getState().clearLastIdbErrorIfSet();
    })
    .catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error('[Store] scheduleClearOcrAllPagesIdbWrite 失敗:', err);
      useInfraStore.getState().setLastIdbError(err);
    });
  trackPendingIdbWork(work);
}

interface PecoState {
  document: PecoDocument | null;
  /**
   * issue #193: ページの表示順序。元の pageIndex (PDF 内での 0-based インデックス) の配列。
   * deletePages / movePage で更新される。初期状態は [0, 1, 2, ..., n-1]。
   * pdfSaver はこの配列を使って PDF を再構築する。
   */
  pageOrder: number[];
  currentPageIndex: number;
  isDirty: boolean;
  selectedIds: Set<string>;
  lastSelectedId: string | null;
  clipboard: TextBlock[];
  undoStack: Action[];
  redoStack: Action[];
  /**
   * issue #201: 最後の保存成功時点の undoStack.length。
   * computeSaveDiff はこの値以降の undoStack エントリを「未保存の変更」として扱う。
   * setDocument（ファイル切替）時は 0 にリセットする。
   */
  lastSavedActionIndex: number;

  // Actions
  /**
   * issue #193: 指定した pageOrder インデックス (displayIndices) のページを削除する。
   * displayIndices は pageOrder 配列上のインデックス (表示順序の位置)。
   * undoable=true (default) で undo スタックに積む。
   *
   * onIdbWork が指定された場合、IDB I/O は呼び出し元（hook 層）に委譲される。
   * 省略時は action 内で IDB I/O を完結させる（後方互換）。
   */
  deletePages: (
    displayIndices: number[],
    onIdbWork?: (filePath: string, deletedPageIndices: number[], renamedEntries: Array<{ oldPageIndex: number; newPageIndex: number }>) => void,
  ) => Promise<void>;
  /**
   * issue #193: ドラッグ並べ替えでページ順序を変更する。
   * fromDisplayIndex / toDisplayIndex は pageOrder 配列上のインデックス。
   *
   * onIdbWork が指定された場合、IDB I/O は呼び出し元（hook 層）に委譲される。
   * 省略時は action 内で IDB I/O を完結させる（後方互換）。
   */
  movePage: (
    fromDisplayIndex: number,
    toDisplayIndex: number,
    onIdbWork?: (filePath: string, renamedEntries: Array<{ oldPageIndex: number; newPageIndex: number }>) => void,
  ) => Promise<void>;
  /**
   * issue #207: 指定した pageIndex のページを時計回りに delta 度回転する。
   * delta は 90 | 180 | 270 のいずれか。
   * undoable=true で RotatePagesAction を undo スタックに積む。
   */
  rotatePages: (pageIndices: number[], delta: 90 | 180 | 270) => void;
  setDocument: (doc: PecoDocument | null, skipViewerReset?: boolean) => void;
  /**
   * issue #118: documentEpoch だけを +1 する。document / pages / currentPageIndex /
   * zoom / undo・redo / isDirty には一切触れない。
   * 保存 (replace_pdf_file) でディスク上の PDF バイト列が差し替わったあと、
   * usePageNavigation / usePdfRendering に「同じ filePath/currentPageIndex でも
   * pdfjs proxy を取り直してページ画像を再 render せよ」と通知するための入口。
   * setDocument と違い編集状態 (textBlocks / BB / dirty / 履歴) を保持する。
   */
  bumpDocumentEpoch: () => void;
  normalizePageOrderAfterSave: (savedPageOrder?: number[]) => void;
  setDocumentFilePath: (filePath: string) => void;
  setCurrentPage: (index: number) => void;
  updatePageData: (pageIndex: number, data: Partial<PageData>, undoable?: boolean) => void;
  resetDirty: (savedPageSnapshots?: Map<number, PageData>) => void;

  toggleSelection: (id: string, multi: boolean) => void;
  // issue #15: lastSelectedId を明示できるようにする (省略時は末尾 id を anchor とする)。
  setSelectedIds: (ids: string[], lastSelectedId?: string | null) => void;
  clearSelection: () => void;
  copySelected: () => void;
  pasteClipboard: (targetCenter?: { x: number; y: number }) => void;
  pushAction: (action: Action) => void;
  undo: () => void;
  redo: () => void;
  clearOcrCurrentPage: () => void;
  clearOcrAllPages: () => void;
  /** issue #201: 保存成功時に呼ぶ。undoStack.length を lastSavedActionIndex にセットする。 */
  setLastSavedActionIndex: (index: number) => void;

  /**
   * issue #93 (Find & Replace): 一括置換を実行する。
   * @returns 影響を受けた件数 (置換ヒット数), ブロック数, ページ数
   * - scope:
   *   - 'selection': 選択中の BB のみ
   *   - 'current': 現在ページの全 BB
   *   - 'all': document.totalPages 全範囲。issue #104: LRU 退避ページも IDB から読み戻して走査する
   * - useRegex=true のときの構文エラーは throw する (UI 側でハンドルする)
   *   useRegex=false のとき、replacement 内の $&, $0, $1, $$ などの特殊扱いを避けるため
   *   String.prototype.replace に渡す前に '$' → '$$' エスケープを行う (issue #105)
   * - skipBlockIds: 編集中などで保護したいブロック ID。スキップしたページに対する skip 数も返す
   * - undo: 影響を受けた全ページを 1 つの update_pages Action にまとめる
   *
   * issue #104: scope='all' で IDB 退避ページも対象になるため async に変更。
   */
  replaceText: (params: {
    scope: 'selection' | 'current' | 'all';
    pattern: string;
    replacement: string;
    caseSensitive: boolean;
    useRegex: boolean;
    skipBlockIds?: ReadonlySet<string>;
  }) => Promise<{ hits: number; blocks: number; pages: number; skippedBlocks: number }>;

  /**
   * issue #213: 複数の置換ルールを 1-pass で適用する高速バッチ版。
   *
   * 旧来の handleBatchApply はルール数 R 回 replaceText を逐次呼び出し、
   * 各呼び出しで IDB フルスキャンを行っていたため O(R×P×B) だった。
   * この action は IDB を 1 度だけ読み込み、各 BB に全ルールをインメモリで
   * 順次適用してから 1 つの UpdatePagesAction として undoStack に積む。
   *
   * @param rules 適用するルール配列 (enabled=false は呼び出し元で除外済み前提)
   * @param scope 'current' = 現在ページのみ, 'all' = 全ページ (IDB 退避ページ含む)
   * @returns totalHits: 全ルール合計ヒット数, perRuleHits: ルールごとのヒット数配列
   *
   * - isRegex=true の場合は RegExp を 1 度だけ生成して使い回す
   * - 各ルールの出力テキストが次ルールの入力になる (連鎖適用)
   * - undoStack には 1 entry のみ追加 (Ctrl+Z 1 回で全部巻き戻し)
   * - IDB 書き込みは変更があったページのみ 1 度ずつ
   */
  replaceTextBatch: (
    rules: Array<{
      pattern: string;
      replacement: string;
      isRegex: boolean;
      caseSensitive: boolean;
    }>,
    scope: 'current' | 'all',
  ) => Promise<{ totalHits: number; perRuleHits: number[] }>;
}

const MAX_CACHED_PAGES = 50;

export const usePecoStore = create<PecoState>((set, get) => ({
  document: null,
  pageOrder: [],
  currentPageIndex: 0,
  isDirty: false,
  selectedIds: new Set(),
  lastSelectedId: null,
  clipboard: [],
  undoStack: [],
  redoStack: [],
  lastSavedActionIndex: 0,

  // issue #193: ページ削除
  // #254: onIdbWork が指定された場合は IDB I/O を hook 層に委譲する。
  // 省略時は従来通り action 内で完結させる（後方互換）。
  deletePages: async (displayIndices, onIdbWork) => {
    // #215: 進行中の IDB 書き込みが完了してから rename/delete を実行することで
    // renameTemporaryPageKeys とのキー競合レース条件を防ぐ。
    // onIdbWork を使う場合は呼び出し元（hook）が await を担う。
    if (!onIdbWork) await waitForPendingIdbSaves();

    const state = get();
    if (!state.document || displayIndices.length === 0) return;

    const beforeOrder = [...state.pageOrder];
    const beforePages = new Map(state.document.pages);
    const beforeTotalPages = state.document.totalPages;
    const beforeCurrentPageIndex = state.currentPageIndex;

    // displayIndices を Set に変換 (重複排除)
    const deleteDisplaySet = new Set(displayIndices);

    // 削除後の新しい pageOrder (表示順) を構築
    const afterOrder = beforeOrder.filter((_, di) => !deleteDisplaySet.has(di));

    if (afterOrder.length === beforeOrder.length) return;

    if (afterOrder.length === 0) {
      // 全ページ削除は許可しない
      console.warn('[pecoStore] deletePages: cannot delete all pages');
      return;
    }

    // afterOrder に残った表示ページを新しい連番 (0-based) に再マッピング
    // 新しい pages Map: key=新pageIndex, value=元ページデータ (pageIndex フィールドを更新)
    // perf(#221): pageIndex が変わらないページは shallow copy を避けてオブジェクト参照を再利用する
    const afterPages = new Map<number, PageData>();
    beforeOrder.forEach((_, oldDisplayIndex) => {
      if (deleteDisplaySet.has(oldDisplayIndex)) return;
      const newIdx = afterPages.size;
      const page = beforePages.get(oldDisplayIndex);
      if (page) {
        afterPages.set(newIdx, page.pageIndex === newIdx ? page : { ...page, pageIndex: newIdx });
      }
    });

    // 削除後の currentPageIndex を調整
    // 現在ページが削除対象なら次ページ (なければ末尾) へ
    // 現在ページが削除対象でないなら新しいインデックスを計算
    const isCurrentDeleted = deleteDisplaySet.has(state.currentPageIndex);
    let afterCurrentPageIndex: number;
    if (isCurrentDeleted) {
      // 削除対象: 現在位置より後に残るページがあればその先頭、なければ末尾
      const nextSurvivorDisplayIndex = (() => {
        for (let di = state.currentPageIndex; di < beforeOrder.length; di++) {
          if (!deleteDisplaySet.has(di)) {
            // afterOrder 内での新しいインデックスを計算
            return afterOrder.indexOf(beforeOrder[di]);
          }
        }
        return afterOrder.length - 1;
      })();
      afterCurrentPageIndex = Math.max(0, Math.min(nextSurvivorDisplayIndex, afterOrder.length - 1));
    } else {
      // 削除対象でない: 現在ページが新しい pageOrder の何番目か
      const newDisplayIndex = afterOrder.indexOf(beforeOrder[state.currentPageIndex]);
      afterCurrentPageIndex = Math.max(0, newDisplayIndex);
    }

    const afterTotalPages = afterOrder.length;

    // Store を更新
    set({
      document: {
        ...state.document,
        pages: afterPages,
        totalPages: afterTotalPages,
      },
      pageOrder: afterOrder,
      currentPageIndex: afterCurrentPageIndex,
      isDirty: true,
      undoStack: [...state.undoStack, {
        type: 'delete_pages' as const,
        beforePages,
        afterPages,
        beforeOrder,
        afterOrder,
        beforeCurrentPageIndex,
        afterCurrentPageIndex,
        beforeTotalPages,
        afterTotalPages,
      }].slice(-100),
      redoStack: [],
    });

    // IDB: 削除されたページのエントリを削除し、残るページの key を新 pageIndex で更新
    const filePath = state.document.filePath;
    const deletedPageIndices = beforeOrder.map((_, di) => di).filter((di) => deleteDisplaySet.has(di));
    const renamedEntries: Array<{ oldPageIndex: number; newPageIndex: number }> = [];
    beforeOrder.forEach((origPageIndex, oldDisplayIndex) => {
      if (deleteDisplaySet.has(oldDisplayIndex)) return;
      const newIdx = afterOrder.indexOf(origPageIndex);
      if (oldDisplayIndex !== newIdx) {
        renamedEntries.push({ oldPageIndex: oldDisplayIndex, newPageIndex: newIdx });
      }
    });

    if (onIdbWork) {
      // #254: IDB I/O を hook 層に委譲する
      onIdbWork(filePath, deletedPageIndices, renamedEntries);
    } else {
      const idbWork = deleteTemporaryPageKeys(filePath, deletedPageIndices)
        .then(() => renameTemporaryPageKeys(filePath, renamedEntries))
        .then(() => {
          useInfraStore.getState().clearLastIdbErrorIfSet();
        })
        .catch((e: unknown) => {
          const err = e instanceof Error ? e : new Error(String(e));
          console.error('[Store] deletePages IDB 同期失敗:', err);
          useInfraStore.getState().setLastIdbError(err);
        });
      const tracked: Promise<void> = idbWork.finally(() => {
        pendingIdbSaves.delete(tracked);
      });
      pendingIdbSaves.add(tracked);
    }
  },

  // issue #193: ページ並べ替え
  // #254: onIdbWork が指定された場合は IDB I/O を hook 層に委譲する。
  // 省略時は従来通り action 内で完結させる（後方互換）。
  movePage: async (fromDisplayIndex, toDisplayIndex, onIdbWork) => {
    // #215: 進行中の IDB 書き込みが完了してから rename を実行することで
    // renameTemporaryPageKeys とのキー競合レース条件を防ぐ。
    // onIdbWork を使う場合は呼び出し元（hook）が await を担う。
    if (!onIdbWork) await waitForPendingIdbSaves();

    const state = get();
    if (!state.document) return;
    if (fromDisplayIndex === toDisplayIndex) return;
    if (fromDisplayIndex < 0 || fromDisplayIndex >= state.pageOrder.length) return;
    if (toDisplayIndex < 0 || toDisplayIndex >= state.pageOrder.length) return;

    const beforeOrder = [...state.pageOrder];

    // 並べ替え後の pageOrder (元ページの originalIndex を移動)
    const newOrder = [...beforeOrder];
    const [moved] = newOrder.splice(fromDisplayIndex, 1);
    newOrder.splice(toDisplayIndex, 0, moved);

    // pages Map も新しいインデックスで再構築
    // perf(#221): pageIndex が変わらないページは shallow copy を避けてオブジェクト参照を再利用する
    const newPages = new Map<number, PageData>();
    newOrder.forEach((origPageIndex, newIdx) => {
      const oldDisplayIndex = beforeOrder.indexOf(origPageIndex);
      const page = state.document!.pages.get(oldDisplayIndex);
      if (page) {
        newPages.set(newIdx, page.pageIndex === newIdx ? page : { ...page, pageIndex: newIdx });
      }
    });

    // currentPageIndex の追従: 移動元/移動先に応じて更新
    let newCurrentPageIndex = state.currentPageIndex;
    if (state.currentPageIndex === fromDisplayIndex) {
      newCurrentPageIndex = toDisplayIndex;
    } else if (fromDisplayIndex < toDisplayIndex) {
      if (state.currentPageIndex > fromDisplayIndex && state.currentPageIndex <= toDisplayIndex) {
        newCurrentPageIndex = state.currentPageIndex - 1;
      }
    } else {
      if (state.currentPageIndex >= toDisplayIndex && state.currentPageIndex < fromDisplayIndex) {
        newCurrentPageIndex = state.currentPageIndex + 1;
      }
    }

    const afterOrder = newOrder;

    set({
      document: {
        ...state.document,
        pages: newPages,
      },
      pageOrder: afterOrder,
      currentPageIndex: newCurrentPageIndex,
      isDirty: true,
      undoStack: [...state.undoStack, {
        type: 'reorder_pages' as const,
        beforeOrder,
        afterOrder,
      }].slice(-100),
      redoStack: [],
    });

    // IDB: 並べ替えに応じて key を更新
    const filePath = state.document.filePath;
    const renamedEntries: Array<{ oldPageIndex: number; newPageIndex: number }> = [];
    newOrder.forEach((origPageIndex, newIdx) => {
      const oldDisplayIndex = beforeOrder.indexOf(origPageIndex);
      if (oldDisplayIndex !== newIdx) {
        renamedEntries.push({ oldPageIndex: oldDisplayIndex, newPageIndex: newIdx });
      }
    });

    if (onIdbWork) {
      // #254: IDB I/O を hook 層に委譲する
      if (renamedEntries.length > 0) onIdbWork(filePath, renamedEntries);
    } else if (renamedEntries.length > 0) {
      const idbWork = renameTemporaryPageKeys(filePath, renamedEntries)
        .then(() => {
          useInfraStore.getState().clearLastIdbErrorIfSet();
        })
        .catch((e: unknown) => {
          const err = e instanceof Error ? e : new Error(String(e));
          console.error('[Store] movePage IDB 同期失敗:', err);
          useInfraStore.getState().setLastIdbError(err);
        });
      const tracked: Promise<void> = idbWork.finally(() => {
        pendingIdbSaves.delete(tracked);
      });
      pendingIdbSaves.add(tracked);
    }
  },

  // issue #207: ページ回転
  rotatePages: (pageIndices, delta) => {
    const state = get();
    if (!state.document || pageIndices.length === 0) return;

    const changes: RotatePagesAction['changes'] = [];
    const newPages = new Map(state.document.pages);

    for (const pageIndex of pageIndices) {
      const page = newPages.get(pageIndex);
      if (!page) continue;
      const before = (page.rotation ?? 0) as 0 | 90 | 180 | 270;
      // fix(#230): IDB から復元した rotation が NaN や 90 の倍数以外になり得る場合に備え
      // Math.round で最近傍 90 度倍数に丸めてから % 360 する。結果を [0,90,180,270] に強制。
      const raw = (Math.round(before / 90) * 90 + delta) % 360;
      const after = (raw < 0 ? raw + 360 : raw) as 0 | 90 | 180 | 270;
      if (before === after) continue;
      newPages.set(pageIndex, { ...page, rotation: after, isDirty: true });
      changes.push({ pageIndex, before, after });
    }

    if (changes.length === 0) return;

    const action: RotatePagesAction = { type: 'rotate_pages', changes };
    set({
      document: { ...state.document, pages: newPages },
      isDirty: true,
      undoStack: [...state.undoStack, action].slice(-100),
      redoStack: [],
    });
  },

  setDocumentFilePath: (filePath) => set((state) => {
    if (!state.document) return state;
    const fileName = filePath.split(/[\\/]/).pop() || state.document.fileName;
    return { document: { ...state.document, filePath, fileName } };
  }),

  setDocument: (doc, skipViewerReset = false) => {
    // infraStore から pendingRestoration を取り出してから state をリセットする
    const restoration = useInfraStore.getState().pendingRestoration;

    set({
      document: doc,
      pageOrder: doc ? Array.from({ length: doc.totalPages }, (_, i) => i) : [],
      currentPageIndex: 0,
      // バックアップ復元時は即座に isDirty=true にしておく
      isDirty: restoration !== null && doc !== null,
      selectedIds: new Set(),
      lastSelectedId: null,
      clipboard: [],
      undoStack: [],
      redoStack: [],
      lastSavedActionIndex: 0,
    });

    // infra 側のリセット
    useInfraStore.getState().bumpDocumentEpoch();
    useInfraStore.getState().resetPageAccessOrder();
    useInfraStore.getState().clearPendingRestoration();
    useInfraStore.getState().clearCurrentPageProxy();

    // viewer UI state のリセット (skipViewerReset=true はテスト等で使う)
    if (!skipViewerReset) {
      useViewerStore.getState().resetViewerState();
    }

    // IDB一時データのクリアをset()外でawaitして確実に完了させる。
    // 復元データがある場合はクリア完了後に IDB へ書き込む（順序保証）。
    if (doc) {
      const work = clearTemporaryChanges(doc.filePath)
        .then(async () => {
          if (!restoration || Object.keys(restoration).length === 0) return;
          const entries = Object.entries(restoration).map(([idx, data]) => ({
            filePath: doc.filePath,
            pageIndex: parseInt(idx, 10),
            data,
          }));
          await saveTemporaryPageDataBatch(entries);
        })
        .then(() => {
          useInfraStore.getState().clearLastIdbErrorIfSet();
        })
        .catch((e: unknown) => {
          const err = e instanceof Error ? e : new Error(String(e));
          console.error('[Store] clearTemporaryChanges/復元書き込み失敗:', err);
          useInfraStore.getState().setLastIdbError(err);
        });

      // finally で自身を Set から除去するため、tracked 変数を先に宣言してから add する
      const tracked: Promise<void> = work.finally(() => {
        pendingIdbSaves.delete(tracked);
      });
      pendingIdbSaves.add(tracked);
    }
  },

  // issue #118: 保存後にディスク上の PDF が差し替わった際、pdfjs proxy の再取得と
  // ページ画像の再 render をトリガーするためだけに documentEpoch を進める。
  // document 本体・pages・currentPageIndex・zoom・undo/redo・isDirty は不変。
  //
  // issue #149: bumpDocumentEpoch 自体は非同期 IDB save (pendingIdbSaves) と
  // 同期しない。呼び出し側 (useFileOperations など) は本関数を呼ぶ前に必ず
  //   await waitForPendingIdbSaves();
  // を実行し、ディスク上の PDF が IDB の最新 state と一致してから epoch を
  // bump する責務を持つ。さもなくば pdfjs が古い IDB blob を再読込して
  // 直前の編集が消えて見える race が発生する。
  bumpDocumentEpoch: () => {
    useInfraStore.getState().bumpDocumentEpochAndClearProxy();
  },

  normalizePageOrderAfterSave: (savedPageOrder) => set((state) => {
    const doc = state.document;
    if (!doc) return state;

    if (savedPageOrder) {
      const matchesSavedOrder =
        savedPageOrder.length === doc.totalPages &&
        state.pageOrder.length === savedPageOrder.length &&
        state.pageOrder.every((sourceIndex, displayIndex) => sourceIndex === savedPageOrder[displayIndex]);
      if (!matchesSavedOrder) return state;
    }

    const identityOrder = Array.from({ length: doc.totalPages }, (_, i) => i);
    const alreadyIdentity =
      state.pageOrder.length === identityOrder.length &&
      state.pageOrder.every((sourceIndex, displayIndex) => sourceIndex === identityOrder[displayIndex]);
    if (alreadyIdentity) return state;

    return {
      pageOrder: identityOrder,
      undoStack: [],
      redoStack: [],
    };
  }),

  setCurrentPage: (index) => {
    perf.mark('nav.click', { to: index });
    const newOrder = useInfraStore.getState().updatePageAccessOrder(index);
    void newOrder; // used via side-effect in infraStore
    set({ currentPageIndex: index, selectedIds: new Set(), lastSelectedId: null });
  },

  updatePageData: (pageIndex, data, undoable = true) => {
    if (perf.enabled) perf.mark('edit.storeEnter', { page: pageIndex, undoable, keys: Object.keys(data).join('|') });
    // LRU退避時のIndexedDB保存をset()の外で非同期実行するためペンディングリストを収集
    const pendingSaves: Array<{ filePath: string; idx: number; page: PageData }> = [];

    set((state) => {
      if (!state.document) return state;
      const oldPage = state.document.pages.get(pageIndex);
      const newPage = oldPage ? { ...oldPage, ...data } : (data as PageData);
      const newPages = new Map(state.document.pages);
      newPages.set(pageIndex, newPage);

      // Update access order via infraStore
      const newOrder = useInfraStore.getState().updatePageAccessOrder(pageIndex);

      // LRU Purge: If we exceed MAX_CACHED_PAGES, remove the oldest non-dirty page
      // OR save dirty page to IDB and then remove from memory.
      if (newPages.size > MAX_CACHED_PAGES) {
        for (let i = newOrder.length - 1; i >= 0; i--) {
          const idxToRemove = newOrder[i];
          const pageToRemove = newPages.get(idxToRemove);
          // Never purge the current page
          if (idxToRemove !== state.currentPageIndex && pageToRemove) {
            if (pageToRemove.isDirty) {
              // set()コールバックは同期のため、保存対象を収集してset()外で非同期実行する
              pendingSaves.push({ filePath: state.document!.filePath, idx: idxToRemove, page: pageToRemove });
            }
            newPages.delete(idxToRemove);
            // LRU order も同期して更新
            useInfraStore.getState().updatePageAccessOrder(idxToRemove);
            if (newPages.size <= MAX_CACHED_PAGES) break;
          }
        }
      }

      const newState: Partial<PecoState> = {
        document: { ...state.document, pages: newPages },
      };

      if (data.isDirty !== false) {
        newState.isDirty = true;
      }

      if (undoable && oldPage) {
        const action: Action = {
          type: 'update_page',
          pageIndex,
          before: oldPage,
          after: newPage
        };
        const newUndo = [...state.undoStack, action];
        if (newUndo.length > 100) newUndo.shift();
        newState.undoStack = newUndo;
        newState.redoStack = [];
      }

      return newState;
    });

    // set()外でIndexedDB保存をバッチ実行（1トランザクションでまとめて書き込み）
    // pendingIdbSaves に登録して保存処理が完了を待機できるようにする
    if (pendingSaves.length > 0) {
      const saveOcrClearGeneration = ocrClearGeneration;
      const work = saveTemporaryPageDataBatch(
        pendingSaves.map(({ filePath, idx, page }) => ({ filePath, pageIndex: idx, data: page }))
      )
        .then(() => {
          useInfraStore.getState().clearLastIdbErrorIfSet();
        })
        .catch((e: unknown) => {
          const err = e instanceof Error ? e : new Error(String(e));
          console.error('[Store] IndexedDB バッチ保存失敗:', err);
          // 保存失敗時は退避していたページをメモリに戻してデータロストを防ぐ（ロールバック）
          set((state) => {
            if (!state.document) return { ...state };
            const currentFilePath = state.document.filePath;
            const pendingSavesForCurrentDocument = pendingSaves.filter(({ filePath }) => filePath === currentFilePath);
            if (pendingSavesForCurrentDocument.length === 0) {
              useInfraStore.getState().setLastIdbError(err);
              return state;
            }
            const restored = new Map(state.document.pages);
            const clearOcrHappenedAfterSave = saveOcrClearGeneration !== ocrClearGeneration;
            for (const { idx, page } of pendingSavesForCurrentDocument) {
              if (!restored.has(idx)) {
                restored.set(idx, clearOcrHappenedAfterSave ? clearedOcrPage(idx, page) : page);
              }
            }
            useInfraStore.getState().setLastIdbError(err);
            return {
              document: { ...state.document, pages: restored },
            };
          });
        });

      // finally で自身を Set から除去するため、tracked 変数を先に宣言してから add する
      const tracked: Promise<void> = work.finally(() => {
        pendingIdbSaves.delete(tracked);
      });
      pendingIdbSaves.add(tracked);
    }
    if (perf.enabled) perf.mark('edit.storeExit', { page: pageIndex, pendingSaves: pendingSaves.length });
  },

  resetDirty: (savedPageSnapshots) => set((state) => {
    if (!state.document) return state;
    // savedPageSnapshots 指定時は「保存スナップショットと同一オブジェクト参照のページ」
    // だけ isDirty を下ろす。保存中に編集されたページは新しいオブジェクト参照になるため
    // 一致せず、その新編集の dirty フラグを巻き込まない (issue #115 / #119)。
    // 省略時は従来通り全ページの isDirty を一律クリアする (後方互換)。
    const newPages = new Map(state.document.pages);
    let anyDirty = false;
    if (savedPageSnapshots) {
      for (const [idx, savedPage] of savedPageSnapshots.entries()) {
        const livePage = newPages.get(idx);
        if (livePage === savedPage && livePage.isDirty) {
          newPages.set(idx, { ...livePage, isDirty: false });
        }
      }
      for (const page of newPages.values()) {
        if (page.isDirty) {
          anyDirty = true;
          break;
        }
      }
    } else {
      for (const [idx, page] of newPages.entries()) {
        if (page.isDirty) {
          newPages.set(idx, { ...page, isDirty: false });
        }
      }
    }
    return {
      document: { ...state.document, pages: newPages },
      isDirty: anyDirty
    };
  }),

  toggleSelection: (id, multi) => set((state) => {
    const newSelection = new Set(multi ? state.selectedIds : []);
    let newLastId = state.lastSelectedId;
    if (newSelection.has(id)) {
      newSelection.delete(id);
      if (newLastId === id) newLastId = null;
    } else {
      newSelection.add(id);
      newLastId = id;
    }
    return { selectedIds: newSelection, lastSelectedId: newLastId };
  }),

  setSelectedIds: (ids, lastSelectedId) =>
    set({
      selectedIds: new Set(ids),
      // 明示 anchor が来ればそれを採用 (issue #15 の Shift+↑↓ 拡張で必要)。
      // 省略 / undefined のときは従来通り末尾 id を anchor にする (後方互換)。
      lastSelectedId: lastSelectedId !== undefined ? lastSelectedId : (ids[ids.length - 1] || null),
    }),

  clearSelection: () => set({ selectedIds: new Set(), lastSelectedId: null }),

  copySelected: () => {
    // issue #146: copy 対象は currentPage に存在する選択 BB のみ。
    // 仕様上、選択 (selectedIds) はページ切替時に clearSelection されるため
    // cross-page 選択は発生しないという前提を採っている。将来サムネイル側で
    // 跨ぎ選択を許容する場合は document.pages 全体を走査して BB を集める
    // 実装に拡張する必要がある (現状は意図的に未対応)。
    const { document, currentPageIndex, selectedIds } = get();
    if (!document || selectedIds.size === 0) return;
    const page = document.pages.get(currentPageIndex);
    if (!page) return;
    const selected = page.textBlocks.filter(b => selectedIds.has(b.id));
    set({ clipboard: selected.map(b => ({ ...b })) });
  },

  pasteClipboard: (targetCenter) => {
    const { document, currentPageIndex, clipboard, updatePageData } = get();
    if (!document || clipboard.length === 0) return;
    const page = document.pages.get(currentPageIndex);
    if (!page) return;

    const newBlocks = [...page.textBlocks];
    const pastedIds = new Set<string>();
    let offsetX = 10;
    let offsetY = 10;

    if (targetCenter) {
      const minX = Math.min(...clipboard.map(b => b.bbox.x));
      const minY = Math.min(...clipboard.map(b => b.bbox.y));
      const maxX = Math.max(...clipboard.map(b => b.bbox.x + b.bbox.width));
      const maxY = Math.max(...clipboard.map(b => b.bbox.y + b.bbox.height));
      offsetX = targetCenter.x - (minX + maxX) / 2;
      offsetY = targetCenter.y - (minY + maxY) / 2;
    }

    clipboard.forEach((b) => {
      const newId = crypto.randomUUID();
      const newBlock: TextBlock = {
        ...b,
        id: newId,
        bbox: { ...b.bbox, x: b.bbox.x + offsetX, y: b.bbox.y + offsetY },
        order: newBlocks.length,
        isNew: true,
        isDirty: true
      };
      newBlocks.push(newBlock);
      pastedIds.add(newId);
    });

    updatePageData(currentPageIndex, { textBlocks: newBlocks, isDirty: true });
    set({ selectedIds: pastedIds });
  },

  pushAction: (action) => set((state) => {
    const newUndo = [...state.undoStack, action];
    if (newUndo.length > 100) newUndo.shift();
    return {
      undoStack: newUndo,
      redoStack: []
    };
  }),

  undo: () => {
    const { undoStack, redoStack, document } = get();
    if (undoStack.length === 0 || !document) return;

    const action = undoStack[undoStack.length - 1];
    const newUndo = undoStack.slice(0, -1);
    const newRedo = [action, ...redoStack];

    if (action.type === 'update_page') {
      const newPages = new Map(document.pages);
      newPages.set(action.pageIndex, action.before);
      const filePath = document.filePath;
      set({
        document: { ...document, pages: newPages },
        undoStack: newUndo,
        redoStack: newRedo,
        isDirty: true
      });
      // LRU 退避済みページが IDB に残っている可能性があるため、
      // 巻き戻し後の状態を IDB へも書き込んでメモリと完全同期させる。
      // (issue #3: undo が LRU 退避ページの IDB と非整合になる)
      schedulePendingIdbWrite([{ filePath, pageIndex: action.pageIndex, data: action.before }]);
    } else if (action.type === 'update_pages') {
      // issue #93: 全ページスコープの置換等で複数ページを atomic に巻き戻す。
      const newPages = new Map(document.pages);
      for (const e of action.entries) {
        newPages.set(e.pageIndex, e.before);
      }
      const filePath = document.filePath;
      set({
        document: { ...document, pages: newPages },
        undoStack: newUndo,
        redoStack: newRedo,
        isDirty: true,
      });
      // 全 entry を IDB へまとめて同期 (LRU 退避ページがあっても整合性を担保)
      schedulePendingIdbWrite(
        action.entries.map(e => ({ filePath, pageIndex: e.pageIndex, data: e.before })),
      );
    } else if (action.type === 'delete_pages') {
      // issue #193: ページ削除を巻き戻す (削除前の状態に戻す)
      set({
        document: {
          ...document,
          pages: action.beforePages,
          totalPages: action.beforeTotalPages,
        },
        pageOrder: action.beforeOrder,
        currentPageIndex: action.beforeCurrentPageIndex,
        undoStack: newUndo,
        redoStack: newRedo,
        isDirty: true,
      });
      // IDB は afterPages -> beforePages への逆変換が複雑なため、
      // beforePages の全ページを IDB に書き込んで強制同期する
      schedulePendingIdbWrite(
        Array.from(action.beforePages.entries()).map(([pi, page]) => ({
          filePath: document.filePath,
          pageIndex: pi,
          data: page,
        })),
      );
    } else if (action.type === 'reorder_pages') {
      // issue #193: ページ並べ替えを巻き戻す
      // beforeOrder から pages を再構築
      const restoredPages = new Map<number, PageData>();
      action.beforeOrder.forEach((origPageIndex, newIdx) => {
        const oldDisplayIndex = action.afterOrder.indexOf(origPageIndex);
        const page = document.pages.get(oldDisplayIndex);
        if (page) restoredPages.set(newIdx, { ...page, pageIndex: newIdx });
      });
      set({
        document: { ...document, pages: restoredPages },
        pageOrder: action.beforeOrder,
        undoStack: newUndo,
        redoStack: newRedo,
        isDirty: true,
      });
    } else if (action.type === 'rotate_pages') {
      // issue #207: ページ回転を巻き戻す (before の角度に戻す)
      const newPages = new Map(document.pages);
      for (const change of action.changes) {
        const page = newPages.get(change.pageIndex);
        if (!page) continue;
        newPages.set(change.pageIndex, { ...page, rotation: change.before, isDirty: true });
      }
      set({
        document: { ...document, pages: newPages },
        undoStack: newUndo,
        redoStack: newRedo,
        isDirty: true,
      });
    }
  },

  redo: () => {
    const { undoStack, redoStack, document } = get();
    if (redoStack.length === 0 || !document) return;

    const action = redoStack[0];
    const newRedo = redoStack.slice(1);
    const newUndo = [...undoStack, action];

    if (action.type === 'update_page') {
      const newPages = new Map(document.pages);
      newPages.set(action.pageIndex, action.after);
      const filePath = document.filePath;
      set({
        document: { ...document, pages: newPages },
        undoStack: newUndo,
        redoStack: newRedo,
        isDirty: true
      });
      // undo と対称: redo 後の状態を IDB へも書き込んで整合性を担保
      schedulePendingIdbWrite([{ filePath, pageIndex: action.pageIndex, data: action.after }]);
    } else if (action.type === 'update_pages') {
      // issue #93: 全ページスコープの置換等で複数ページを atomic にやり直す。
      const newPages = new Map(document.pages);
      for (const e of action.entries) {
        newPages.set(e.pageIndex, e.after);
      }
      const filePath = document.filePath;
      set({
        document: { ...document, pages: newPages },
        undoStack: newUndo,
        redoStack: newRedo,
        isDirty: true,
      });
      schedulePendingIdbWrite(
        action.entries.map(e => ({ filePath, pageIndex: e.pageIndex, data: e.after })),
      );
    } else if (action.type === 'delete_pages') {
      // issue #193: ページ削除をやり直す
      set({
        document: {
          ...document,
          pages: action.afterPages,
          totalPages: action.afterTotalPages,
        },
        pageOrder: action.afterOrder,
        currentPageIndex: action.afterCurrentPageIndex,
        undoStack: newUndo,
        redoStack: newRedo,
        isDirty: true,
      });
      schedulePendingIdbWrite(
        Array.from(action.afterPages.entries()).map(([pi, page]) => ({
          filePath: document.filePath,
          pageIndex: pi,
          data: page,
        })),
      );
    } else if (action.type === 'reorder_pages') {
      // issue #193: ページ並べ替えをやり直す
      const restoredPages = new Map<number, PageData>();
      action.afterOrder.forEach((origPageIndex, newIdx) => {
        const oldDisplayIndex = action.beforeOrder.indexOf(origPageIndex);
        const page = document.pages.get(oldDisplayIndex);
        if (page) restoredPages.set(newIdx, { ...page, pageIndex: newIdx });
      });
      set({
        document: { ...document, pages: restoredPages },
        pageOrder: action.afterOrder,
        undoStack: newUndo,
        redoStack: newRedo,
        isDirty: true,
      });
    } else if (action.type === 'rotate_pages') {
      // issue #207: ページ回転をやり直す (after の角度に進める)
      const newPages = new Map(document.pages);
      for (const change of action.changes) {
        const page = newPages.get(change.pageIndex);
        if (!page) continue;
        newPages.set(change.pageIndex, { ...page, rotation: change.after, isDirty: true });
      }
      set({
        document: { ...document, pages: newPages },
        undoStack: newUndo,
        redoStack: newRedo,
        isDirty: true,
      });
    }
  },

  clearOcrCurrentPage: () => {
    const { document, currentPageIndex, updatePageData } = get();
    if (!document) return;
    const page = document.pages.get(currentPageIndex);
    if (!page) return;
    updatePageData(currentPageIndex, { textBlocks: [], isDirty: true, isTextExtracted: true, ocrCleared: true });
  },

  setLastSavedActionIndex: (index) => set({ lastSavedActionIndex: index }),

  clearOcrAllPages: () => {
    const { document } = get();
    if (!document) return;
    const filePath = document.filePath;
    const totalPages = document.totalPages;
    ocrClearGeneration += 1;
    set((state) => {
      if (!state.document) return state;
      // perf(#241): totalPages 件の空 PageData を生成する代わりに、
      // in-memory に存在するページのみを走査して textBlocks を空にする。
      // LRU で退避済みページ (Map に無いもの) は IDB に空 OCR 状態を書いて同期する。
      const newPages = new Map<number, PageData>();
      for (const [idx, page] of state.document.pages.entries()) {
        newPages.set(idx, clearedOcrPage(idx, page));
      }
      return {
        document: { ...state.document, pages: newPages },
        isDirty: true,
        undoStack: [],
        redoStack: [],
      };
    });
    scheduleClearOcrAllPagesIdbWrite(filePath, totalPages);
  },

  /**
   * scope について:
   *  - 'current'  : 現在ページの全 BB
   *  - 'all'      : 全ページ。LRU で in-memory から退避されたページも IDB から読み戻して対象に含める
   *  - 'selection': **現在ページの選択 BB のみ**。LRU 退避された他ページに対する選択は対象外。
   *                 (実装上 selectedIds は currentPage と紐づくため、退避ページに選択が残っていても
   *                  basePages に他ページが入らないので対象に上がらない。issue #139)
   */
  replaceText: async ({ scope, pattern, replacement, caseSensitive, useRegex, skipBlockIds }) => {
    const state = get();
    const document = state.document;
    if (!document) return { hits: 0, blocks: 0, pages: 0, skippedBlocks: 0 };
    if (pattern.length === 0) return { hits: 0, blocks: 0, pages: 0, skippedBlocks: 0 };

    // 検索用の RegExp を組み立てる。useRegex=false は escape して flag 'g' を必ず付ける。
    // useRegex=true の場合は構文エラーが上に伝播する (UI で catch する想定)。
    const flags = `g${caseSensitive ? '' : 'i'}`;
    const re = useRegex
      ? new RegExp(pattern, flags)
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);

    // issue #105: String.prototype.replace は replacement 内の $&, $0, $1, $$ を
    // 特殊解釈する。useRegex=false では replacement を literal として扱うため '$' を
    // '$$' にエスケープする。useRegex=true ではユーザ意図で後方参照を使う想定なのでそのまま。
    const safeReplacement = useRegex
      ? replacement
      : replacement.replace(/\$/g, '$$$$');

    const filePath = document.filePath;

    // issue #104: scope='all' で LRU 退避ページ (in-memory pages Map から外れたもの) も
    // IDB から読み戻して走査対象に含める。
    // 各 idx について「走査ベース PageData」を構築する。in-memory 優先、無ければ IDB の
    // textBlocks を完全 PageData に詰め直す (width/height/thumbnail は欠落しても 0/null で補完)。
    const basePages = new Map<number, PageData>();
    if (scope === 'selection' || scope === 'current') {
      const page = document.pages.get(state.currentPageIndex);
      if (page) basePages.set(state.currentPageIndex, page);
    } else {
      // in-memory に存在するページを先に積む
      for (const [idx, page] of document.pages.entries()) {
        basePages.set(idx, page);
      }
      // IDB から退避ページを読み戻し、in-memory に無い idx だけ追加
      const idbAll = await getAllTemporaryPageData(filePath);
      for (const [idx, partial] of idbAll.entries()) {
        if (basePages.has(idx)) continue;
        if (!partial.textBlocks) continue;
        const restored: PageData = {
          pageIndex: idx,
          width: partial.width ?? 0,
          height: partial.height ?? 0,
          textBlocks: partial.textBlocks,
          isDirty: partial.isDirty ?? false,
          thumbnail: partial.thumbnail ?? null,
          isTextExtracted: partial.isTextExtracted,
          ocrCleared: partial.ocrCleared,
        };
        basePages.set(idx, restored);
      }
    }

    const selectedIds = state.selectedIds;
    const skip = skipBlockIds ?? new Set<string>();

    // perf(#223): useRegex=true の後方参照解決用の non-global 版 RegExp を outer scope で
    // 1 度だけ生成する。旧実装は replacer callback 内で毎マッチ new RegExp していた。
    const oneShotRe = useRegex
      ? new RegExp(re.source, re.flags.replace('g', ''))
      : null;

    let totalHits = 0;
    let totalBlocks = 0;
    let skippedBlocks = 0;
    const entries: Array<{ pageIndex: number; before: PageData; after: PageData }> = [];

    // 安定した順序で走査 (in-memory + IDB 復元の順序差を吸収)
    const targetIndices = Array.from(basePages.keys()).sort((a, b) => a - b);

    for (const pageIdx of targetIndices) {
      const page = basePages.get(pageIdx);
      if (!page) continue;

      let pageChanged = false;
      const newTextBlocks: TextBlock[] = [];
      for (const b of page.textBlocks) {
        // selection スコープでは選択 ID のみ対象
        if (scope === 'selection' && !selectedIds.has(b.id)) {
          newTextBlocks.push(b);
          continue;
        }
        // 編集中などで保護されたブロックは skip
        if (skip.has(b.id)) {
          // それでも本来 hit 候補だったかを数える (UI 警告用)
          re.lastIndex = 0;
          if (re.test(b.text)) skippedBlocks++;
          newTextBlocks.push(b);
          continue;
        }

        re.lastIndex = 0;
        // issue #177: replace と count を 1 回の regex 走査で済ませる。
        // 旧実装は `b.text.replace(re, safeReplacement)` と `b.text.match(re)` を
        // 2 回走らせており、scope='all' の長大テキスト × 全ページでメインスレッド
        // をブロックしていた。replacer に関数を渡せば match ごとに hit++ できる。
        // safeReplacement (useRegex=false) の '$$' エスケープは replacer の戻り値では
        // 不要 (文字列が返り値としてそのまま使われる) のため、生の replacement を返す。
        let hits = 0;
        const literalReplacement = replacement;
        const replaced = b.text.replace(re, useRegex
          ? (...args) => {
              hits++;
              // useRegex=true: 後方参照を反映させるため $-string で再 replace する。
              // ただし replacer 内で動的に行うので、match 全体を素材に同じ正規表現
              // ではなく安全に safeReplacement を適用する手段が必要。ここでは
              // String.prototype.replace の "1回限り" 呼び出しで $-参照を解決する。
              // perf(#223): oneShotRe は outer scope で 1 度だけ生成済み (毎マッチ new RegExp しない)
              const matchStr = args[0] as string;
              return matchStr.replace(oneShotRe!, safeReplacement);
            }
          : () => {
              hits++;
              return literalReplacement;
            });
        if (hits === 0) {
          newTextBlocks.push(b);
          continue;
        }
        totalHits += hits;
        totalBlocks++;
        pageChanged = true;
        newTextBlocks.push({
          ...b,
          text: replaced,
          isDirty: true,
        });
      }

      if (pageChanged) {
        const newPage: PageData = { ...page, textBlocks: newTextBlocks, isDirty: true };
        entries.push({ pageIndex: pageIdx, before: page, after: newPage });
      }
    }

    if (entries.length === 0) {
      return { hits: 0, blocks: 0, pages: 0, skippedBlocks };
    }

    // store に反映
    set((s) => {
      if (!s.document) return s;
      const newPages = new Map(s.document.pages);
      for (const e of entries) {
        // 退避済みページの after も in-memory に積む (LRU で再度退避され得る)
        newPages.set(e.pageIndex, e.after);
      }
      const newAction: Action = { type: 'update_pages', entries };
      const newUndo = [...s.undoStack, newAction];
      if (newUndo.length > 100) newUndo.shift();
      return {
        document: { ...s.document, pages: newPages },
        undoStack: newUndo,
        redoStack: [],
        isDirty: true,
      };
    });

    // LRU 退避済みページの IDB と整合させるため、変更ページ全部を IDB にも書き込む
    schedulePendingIdbWrite(
      entries.map(e => ({ filePath, pageIndex: e.pageIndex, data: e.after })),
    );

    return { hits: totalHits, blocks: totalBlocks, pages: entries.length, skippedBlocks };
  },

  // issue #213: 1-pass batch replace
  replaceTextBatch: async (rules, scope) => {
    const state = get();
    const document = state.document;
    if (!document) return { totalHits: 0, perRuleHits: rules.map(() => 0) };
    if (rules.length === 0) return { totalHits: 0, perRuleHits: [] };

    // 各ルールの RegExp と置換文字列を事前にコンパイルする (1 度だけ生成して使い回す)
    // perf(#223): isRegex=true の後方参照解決用 non-global 版も outer scope で 1 度だけ生成する
    const compiledRules = rules.map((rule) => {
      const flags = `g${rule.caseSensitive ? '' : 'i'}`;
      const re = rule.isRegex
        ? new RegExp(rule.pattern, flags)
        : new RegExp(rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      // useRegex=false のとき '$' → '$$' エスケープ (issue #105 と同じロジック)
      const safeReplacement = rule.isRegex
        ? rule.replacement
        : rule.replacement.replace(/\$/g, '$$$$');
      // isRegex=true のみ非 global 版を生成。false なら null で replacer 内では使わない
      const oneShotRe = rule.isRegex
        ? new RegExp(re.source, re.flags.replace('g', ''))
        : null;
      return { re, safeReplacement, isRegex: rule.isRegex, literalReplacement: rule.replacement, oneShotRe };
    });

    const filePath = document.filePath;

    // IDB を 1 度だけ読み込む (scope='all' のみ; current は in-memory のみ)
    const basePages = new Map<number, PageData>();
    if (scope === 'current') {
      const page = document.pages.get(state.currentPageIndex);
      if (page) basePages.set(state.currentPageIndex, page);
    } else {
      for (const [idx, page] of document.pages.entries()) {
        basePages.set(idx, page);
      }
      const idbAll = await getAllTemporaryPageData(filePath);
      for (const [idx, partial] of idbAll.entries()) {
        if (basePages.has(idx)) continue;
        if (!partial.textBlocks) continue;
        const restored: PageData = {
          pageIndex: idx,
          width: partial.width ?? 0,
          height: partial.height ?? 0,
          textBlocks: partial.textBlocks,
          isDirty: partial.isDirty ?? false,
          thumbnail: partial.thumbnail ?? null,
          isTextExtracted: partial.isTextExtracted,
          ocrCleared: partial.ocrCleared,
        };
        basePages.set(idx, restored);
      }
    }

    const perRuleHits: number[] = rules.map(() => 0);
    const entries: Array<{ pageIndex: number; before: PageData; after: PageData }> = [];

    const targetIndices = Array.from(basePages.keys()).sort((a, b) => a - b);

    for (const pageIdx of targetIndices) {
      const page = basePages.get(pageIdx);
      if (!page) continue;

      let pageChanged = false;
      const newTextBlocks: TextBlock[] = [];

      for (const b of page.textBlocks) {
        let currentText = b.text;
        let blockChanged = false;

        // 全ルールをインメモリで順次適用 (前ルールの出力が次ルールの入力)
        for (let ri = 0; ri < compiledRules.length; ri++) {
          const { re, safeReplacement, isRegex, literalReplacement, oneShotRe } = compiledRules[ri];
          re.lastIndex = 0;

          let ruleHits = 0;
          const replaced = currentText.replace(re, isRegex
            ? (...args) => {
                ruleHits++;
                // perf(#223): oneShotRe は compiledRules 生成時に 1 度だけ作成済み (毎マッチ new RegExp しない)
                const matchStr = args[0] as string;
                return matchStr.replace(oneShotRe!, safeReplacement);
              }
            : () => {
                ruleHits++;
                return literalReplacement;
              });

          if (ruleHits > 0) {
            perRuleHits[ri] += ruleHits;
            currentText = replaced;
            blockChanged = true;
          }
        }

        if (blockChanged) {
          pageChanged = true;
          newTextBlocks.push({ ...b, text: currentText, isDirty: true });
        } else {
          newTextBlocks.push(b);
        }
      }

      if (pageChanged) {
        const newPage: PageData = { ...page, textBlocks: newTextBlocks, isDirty: true };
        entries.push({ pageIndex: pageIdx, before: page, after: newPage });
      }
    }

    const totalHits = perRuleHits.reduce((sum, h) => sum + h, 0);

    if (entries.length === 0) {
      return { totalHits: 0, perRuleHits };
    }

    // store に反映し、undoStack に 1 entry だけ積む
    set((s) => {
      if (!s.document) return s;
      const newPages = new Map(s.document.pages);
      for (const e of entries) {
        newPages.set(e.pageIndex, e.after);
      }
      const newAction: Action = { type: 'update_pages', entries };
      const newUndo = [...s.undoStack, newAction];
      if (newUndo.length > 100) newUndo.shift();
      return {
        document: { ...s.document, pages: newPages },
        undoStack: newUndo,
        redoStack: [],
        isDirty: true,
      };
    });

    // IDB 書き込みは変更ページのみ 1 度ずつ
    schedulePendingIdbWrite(
      entries.map(e => ({ filePath, pageIndex: e.pageIndex, data: e.after })),
    );

    return { totalHits, perRuleHits };
  },
}));

// ─── Selectors ─── (細粒度購読でApp全体の再レンダリング波及を防ぐ)
export const selectDocument = (s: PecoState) => s.document;
// issue #193: ページ表示順序
export const selectPageOrder = (s: PecoState) => s.pageOrder;
export const selectCurrentPageIndex = (s: PecoState) => s.currentPageIndex;
export const selectSelectedIds = (s: PecoState) => s.selectedIds;
export const selectIsDirty = (s: PecoState) => s.isDirty;
export const selectUndoStack = (s: PecoState) => s.undoStack;
export const selectRedoStack = (s: PecoState) => s.redoStack;
export const selectCurrentPage = (s: PecoState) =>
  s.document?.pages.get(s.currentPageIndex) ?? null;
// 現在ページの textBlocks のみを購読するためのセレクタ。
// PageData 自体は updatePageData のたびに別参照になるが、textBlocks 配列は
// 更新したフィールドが textBlocks 以外（thumbnail / isTextExtracted など）の
// 場合は前回と同じ参照のままなので、購読側の再レンダリング/effect 再実行が抑えられる。
// (issue #22)
export const selectCurrentPageTextBlocks = (s: PecoState) =>
  s.document?.pages.get(s.currentPageIndex)?.textBlocks ?? null;
export const selectHasDocument = (s: PecoState) => s.document !== null;
// issue #134: document 全体を購読すると updatePageData (別ページ含む) 毎に
// 再レンダされてしまうため、PdfCanvas/OcrEditor では filePath / totalPages の
// primitive のみを購読する。
export const selectDocumentFilePath = (s: PecoState) => s.document?.filePath;
export const selectDocumentTotalPages = (s: PecoState) => s.document?.totalPages;
// issue #201: 最後の保存以降の未保存変更を diff 計算する基準インデックス
export const selectLastSavedActionIndex = (s: PecoState) => s.lastSavedActionIndex;

// ─── Legacy selectors (infraStore に移動したが後方互換エイリアスとして残す) ───
// 消費側は直接 useInfraStore / selectLastIdbError 等に移行すること。
export const selectLastIdbError = (s: PecoState & { lastIdbError?: Error | null }) =>
  s.lastIdbError ?? useInfraStore.getState().lastIdbError;
export const selectCurrentPageProxy = (s: PecoState & { currentPageProxy?: unknown }) =>
  s.currentPageProxy ?? useInfraStore.getState().currentPageProxy;
export const selectCurrentPageProxyKey = (s: PecoState & { currentPageProxyKey?: unknown }) =>
  s.currentPageProxyKey ?? useInfraStore.getState().currentPageProxyKey;
