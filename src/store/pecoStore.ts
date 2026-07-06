import { create } from 'zustand';
import { PecoDocument, PageData, Action, TextBlock, RotatePagesAction } from '../types';
import { useViewerStore } from './viewerStore';
import { useInfraStore } from './infraStore';
import {
  saveTemporaryPageDataBatch,
  clearTemporaryChanges,
  getAllTemporaryPageData,
  deleteTemporaryPageKeys,
} from '../utils/pdfLoader';
import { resolvePageId, resolveDisplayIndex, pageOrderEquals } from '../utils/pageOrder';
import { perf } from '../utils/perfLogger';
import { remapBboxForRotation, normalizeRotation } from '../utils/pdfSaverCore';

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

/**
 * F-2 (bug-hunt): undoStack のトリム（先頭からのオーバーフロー除去。.slice(-100) /
 * .shift() のいずれの方式でも）で先頭のエントリが失われたら、lastSavedActionIndex
 * （保存チェックポイント = undoStack 上のインデックス）もトリムした件数だけ
 * 繰り下げる。繰り下げないと、保存チェックポイントが「もう存在しないインデックス」を
 * 指したままになり、以降 computeSaveDiff の undoStack.slice(lastSavedActionIndex) が
 * 常に空を返す（100 件到達後、保存 diff プレビュー/監査ログが恒久的に沈黙する）。
 * #350 (PCT-127) の undo/redo 側の追従（Math.min(lastSavedActionIndex, newUndo.length)）
 * と対になる、push 側（先頭トリム）の追従ロジック。
 */
function adjustLastSavedActionIndexForTrim(current: number, trimmedCount: number): number {
  return trimmedCount > 0 ? Math.max(0, current - trimmedCount) : current;
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
 *
 * PCT-104 (A-lite 段階2): entries の pageIndex は displayIndex として扱い、
 * pageOrder を使って pageId に変換してから IDB に書く。
 *
 * PCT-108 (P1): pageOrder は呼び出し元が「action の set() 反映時点の値」を
 * クロージャでキャプチャして渡す。書き込みは保存処理の長い await を跨いで
 * 遅延実行されるため、ここで usePecoStore.getState().pageOrder を遅延参照すると
 * 保存中に走った並べ替え undo/redo でライブ pageOrder が乖離し、書き込み先 pageId が
 * 保存スナップショット体系とずれて remap の掃除対象から外れる (キー競合)。
 * 呼び出し元が action 時点の pageOrder を固定して渡すことで、各書き込みが
 * 自分の action の displayIndex 体系で一貫した pageId に着地する。
 */
function schedulePendingIdbWrite(
  entries: Array<{ filePath: string; pageIndex: number; data: Partial<PageData> }>,
  pageOrder: number[],
  options?: { afterPending?: boolean },
): void {
  if (entries.length === 0) return;
  const infra = useInfraStore.getState();
  const pendingBeforeWrite = options?.afterPending ? waitForPendingIdbSaves() : Promise.resolve();
  const work = pendingBeforeWrite
    .then(() => {
      // PCT-104: displayIndex -> pageId 変換
      // PCT-108: pageOrder は呼び出し元キャプチャ値を使う (遅延 getState は禁止)
      const pageIdEntries = entries.map(({ filePath, pageIndex, data }) => ({
        filePath,
        pageId: resolvePageId(pageOrder, pageIndex),
        data,
      }));
      return saveTemporaryPageDataBatch(pageIdEntries);
    })
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

/**
 * PCT-104 (A-lite 段階3): undo/redo によるページ構造変更を
 * IDB 一時退避 (temporary_changes) と同期させる共通ヘルパ。
 * 1. deletePageIds のエントリ削除 (redo での削除再適用)
 * 2. contentEntries の内容書き込み (メモリ snapshot との強制同期)
 * を 1 本の Promise として直列実行し、trackPendingIdbWork で保存経路と同期する。
 * 進行中の IDB 書き込みとキーが競合しないよう、開始前に待機する (#215 と同じ理由)。
 *
 * deletePageIds は呼び出し元で変換済みの pageId 文字列配列。
 * contentEntries.pageIndex は set() 後の新 pageOrder での displayIndex として扱い、
 * 内部で pageId に変換して書き込む。
 *
 * PCT-108 (P1): contentPageOrder は呼び出し元が set() 反映後の pageOrder を
 * キャプチャして渡す。deletePageIds と同様に「呼び出し元で変換済み」へ揃え、
 * 遅延実行中に保存と並走した undo/redo でライブ pageOrder が乖離しても、
 * 書き込み先 pageId が action 時点の体系からずれないようにする。
 *
 * F-4 (bug-hunt): scheduleRotateUndoRedoIdbWrite (#393) は capturedEpoch を受け取り、
 * waitForPendingIdbSaves() 後 / IDB 操作後の二重ガードで「待機中のファイル切替」を
 * 検知して no-op にするが、この関数には同種のガードが無く非対称だった。
 * capturedEpoch を追加し、呼び出し元 (undo/redo) が action 反映 set() 実行時点の
 * epoch をキャプチャして渡す前提に揃える。
 */
function scheduleStructuralUndoRedoIdbSync(
  filePath: string,
  options: {
    deletePageIds?: string[];
    contentEntries?: Array<{ pageIndex: number; data: Partial<PageData> }>;
    contentPageOrder: number[];
  },
  capturedEpoch: number,
): void {
  const deletes = options.deletePageIds ?? [];
  const contents = options.contentEntries ?? [];
  if (deletes.length === 0 && contents.length === 0) return;
  const pageOrder = options.contentPageOrder;
  const work = waitForPendingIdbSaves()
    .then(async () => {
      // documentEpoch ガード: 待機中にファイル切替/開き直しが起きていたら中止する。
      // scheduleRotateUndoRedoIdbWrite (#393) と同型の二重ガード。
      if (useInfraStore.getState().documentEpoch !== capturedEpoch) return;
      if (deletes.length > 0) {
        await deleteTemporaryPageKeys(filePath, deletes);
      }
      // epoch ガード再確認: deleteTemporaryPageKeys の await 中にも切替が起きうる。
      if (useInfraStore.getState().documentEpoch !== capturedEpoch) return;
      if (contents.length === 0) return;
      // PCT-104: contentEntries.pageIndex は set() 後の pageOrder での displayIndex
      // PCT-108: pageOrder は呼び出し元キャプチャ値を使う (遅延 getState は禁止)
      await saveTemporaryPageDataBatch(
        contents.map(({ pageIndex, data }) => ({
          filePath,
          pageId: resolvePageId(pageOrder, pageIndex),
          data,
        }))
      );
    })
    .then(() => {
      useInfraStore.getState().clearLastIdbErrorIfSet();
    })
    .catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error('[Store] scheduleStructuralUndoRedoIdbSync 失敗:', err);
      useInfraStore.getState().setLastIdbError(err);
    });
  trackPendingIdbWork(work);
}


/**
 * PCT-181 (#412): 遅延実行時に live getState() を読まない。
 * スケジュール時点 (clearOcrAllPages 実行時、同期) の livePages / pageOrder /
 * documentEpoch を呼び出し元がキャプチャして渡す。
 * 実行時に documentEpoch が変化していたら (ファイル切替/開き直しが割り込んだ)
 * no-op にし、切替後の live state への誤書込を防ぐ。
 * schedulePendingIdbWrite (PCT-108) と同じ「遅延 getState 禁止」規律に合わせる。
 */
function scheduleClearOcrAllPagesIdbWrite(
  filePath: string,
  totalPages: number,
  livePages: Map<number, PageData>,
  pageOrder: number[],
  capturedEpoch: number,
): void {
  const pendingBeforeWrite = waitForPendingIdbSaves();
  const work = pendingBeforeWrite
    .then(async () => {
      // documentEpoch ガード: 待機中にファイル切替/開き直しが起きていたら中止する。
      if (useInfraStore.getState().documentEpoch !== capturedEpoch) return;
      // PCT-104 (A-lite 段階2): getAllTemporaryPageData は Map<pageId, data> を返す。
      // OCR クリア前に pageOrder が初期連番 [0..n-1] であるため、
      // idx と src:idx は 1:1 対応する（move/delete 前の全ページ一括操作のため）。
      const idbPages = await getAllTemporaryPageData(filePath);
      // epoch ガード再確認: getAllTemporaryPageData の await 中にも切替が起きうる。
      if (useInfraStore.getState().documentEpoch !== capturedEpoch) return;
      const entries = Array.from({ length: totalPages }, (_, idx) => {
        const pageId = resolvePageId(pageOrder, idx);
        return {
          filePath,
          pageId,
          data: livePages.has(idx)
            ? clearedOcrPage(idx, livePages.get(idx)!)
            : clearedOcrData(idx, idbPages.get(pageId) ?? {}),
        };
      });
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

/**
 * #393 (PCT-162): undo/redo の rotate_pages 分岐を update_page/update_pages と対称に
 * IDB write-through させる。RotatePagesAction は差分 (before/after rotation) のみを
 * 保持し全 PageData を持たないため、in-memory に残っているページはそのまま書けるが、
 * LRU 退避 (in-memory に無い) ページは saveTemporaryPageDataBatch が store.put で
 * レコード全体を置換する仕様上、rotation だけの部分データを書くと textBlocks 等の
 * 既存フィールドが消えてしまう (scheduleClearOcrAllPagesIdbWrite と同じ制約)。
 * そのため退避ページのみ既存 IDB レコードを読み戻し、rotation を上書きしてから書く。
 *
 * PCT-108: pageOrder は呼び出し元が action 時点の値をキャプチャして渡す。
 * PCT-181 (#412 先例): waitForPendingIdbSaves() → getAllTemporaryPageData() と
 * 2 つの await を跨ぐ read-modify-write のため、scheduleClearOcrAllPagesIdbWrite と
 * 同型の documentEpoch 二重ガード (待機後 / IDB read 後) を持つ。呼び出し元がキャプチャした
 * capturedEpoch と不一致なら、途中経過を破棄して no-op にする (ファイル切替後の誤書込防止)。
 */
function scheduleRotateUndoRedoIdbWrite(
  filePath: string,
  changes: Array<{ pageIndex: number; rotation: 0 | 90 | 180 | 270 }>,
  livePages: Map<number, PageData>,
  pageOrder: number[],
  capturedEpoch: number,
): void {
  if (changes.length === 0) return;
  const pendingBeforeWrite = waitForPendingIdbSaves();
  const work = pendingBeforeWrite
    .then(async () => {
      // documentEpoch ガード: 待機中にファイル切替/開き直しが起きていたら中止する。
      if (useInfraStore.getState().documentEpoch !== capturedEpoch) return;
      const hasEvicted = changes.some((c) => !livePages.has(c.pageIndex));
      const idbAll = hasEvicted ? await getAllTemporaryPageData(filePath) : null;
      // epoch ガード再確認: getAllTemporaryPageData の await 中にも切替が起きうる。
      if (useInfraStore.getState().documentEpoch !== capturedEpoch) return;
      const pageIdEntries: Array<{ filePath: string; pageId: string; data: Partial<PageData> }> = [];
      for (const { pageIndex, rotation } of changes) {
        const pageId = resolvePageId(pageOrder, pageIndex);
        const livePage = livePages.get(pageIndex);
        if (livePage) {
          pageIdEntries.push({ filePath, pageId, data: livePage });
          continue;
        }
        // LRU 退避ページ: 既存 IDB レコードを保持しつつ rotation だけ更新する。
        // stored が無い (textBlocks を持たない = 巻き戻す実体が無い) 場合は
        // {pageIndex, rotation, isDirty} のみの骨格レコードを書かない。forward の
        // rotatePages が `if (partial && partial.textBlocks)` で同じケースを除外する
        // のと対称にする (骨格レコードは PageData 型不変条件を破り、保存時のテキスト層
        // strip に繋がりうるため)。
        const stored = idbAll?.get(pageId);
        if (!stored || !stored.textBlocks) continue;
        const data: Partial<PageData> = {
          ...stored,
          pageIndex,
          rotation,
          isDirty: true,
          pageId: stored.pageId ?? pageId,
        };
        pageIdEntries.push({ filePath, pageId, data });
      }
      if (pageIdEntries.length === 0) return;
      await saveTemporaryPageDataBatch(pageIdEntries);
    })
    .then(() => {
      useInfraStore.getState().clearLastIdbErrorIfSet();
    })
    .catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error('[Store] scheduleRotateUndoRedoIdbWrite 失敗:', err);
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
    onIdbWork?: (filePath: string, deletedPageIds: string[]) => void,
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
    onIdbWork?: (filePath: string) => void,
  ) => Promise<void>;
  /**
   * issue #207: 指定した pageIndex のページを時計回りに delta 度回転する。
   * delta は 90 | 180 | 270 のいずれか。
   * undoable=true で RotatePagesAction を undo スタックに積む。
   *
   * PCT-183 (#414): in-memory pages Map に無いページ (未ロード or LRU 退避済み) は
   * IDB (temporary_changes) から読み戻して回転を適用する (#403/#412 と同じ復元パターン)。
   * IDB にも無い (本当に未ロード) ページは回転を適用できないためスキップし、
   * その pageIndex 一覧を戻り値の skippedPageIndices で呼び出し元へ返す
   * (呼び出し元がトースト等でユーザーに通知する)。
   */
  rotatePages: (pageIndices: number[], delta: 90 | 180 | 270) => Promise<{ skippedPageIndices: number[] }>;
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
  /**
   * P1-1/P1-2 (bug-hunt): bytePreserved=true のとき (undecodable byte-preserve 短絡で
   * 何も焼き込まれなかった保存) は、savedPageSnapshots が渡されていても一切変更しない
   * (isDirty も rotation/bbox も維持する)。省略時は false 扱い (従来どおり)。
   */
  resetDirty: (savedPageSnapshots?: Map<number, PageData>, bytePreserved?: boolean) => void;

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
   * - #338 (PCT-115): useRegex=true のときの構文エラーは throw せず、hits:0 の安全な戻り値に
   *   `regexError` (エラーメッセージ) を添えて返す。UI 層 (useFindReplace の regexError) が
   *   一次防御だが、呼び出し元の実装変更に対する store 側の defense-in-depth として、
   *   replaceTextBatch の invalidRuleIndices と対称な設計にしている。
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
  }) => Promise<{ hits: number; blocks: number; pages: number; skippedBlocks: number; regexError?: string }>;

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
   * @returns totalHits: 全ルール合計ヒット数, perRuleHits: ルールごとのヒット数配列,
   *          invalidRuleIndices: pattern の RegExp コンパイルに失敗した rules 配列上の index
   *
   * - isRegex=true の場合は RegExp を 1 度だけ生成して使い回す
   * - 不正な正規表現 (isRegex=true でコンパイル失敗) のルールは throw せずスキップする。
   *   perRuleHits は 0 のまま・invalidRuleIndices に index を積んで返す (呼び出し元で通知用)。
   *   1 ルールの不正が同一バッチ内の他の正常なルールを巻き添えにしない。
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
  ) => Promise<{ totalHits: number; perRuleHits: number[]; invalidRuleIndices: number[] }>;
}

export const MAX_CACHED_PAGES = 50;

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
    // F-6 (bug-hunt): waitForPendingIdbSaves 待機前のドキュメント同一性をキャプチャする。
    // displayIndices は呼び出し元が「この時点で開いているドキュメント」の pageOrder を
    // 基準に決めた値。待機中にファイル切替が起きると、待機後の pre.document は既に
    // 別ファイルに変わっているにもかかわらず、以降の処理は無検証で displayIndices を
    // その新ドキュメントへ適用してしまい、無関係なページを削除する事故になる。
    const entryFilePath = get().document?.filePath ?? null;
    const entryEpoch = useInfraStore.getState().documentEpoch;
    // #215: 進行中の IDB 書き込みが完了してから delete を実行することで
    // キー競合レース条件を防ぐ。onIdbWork を使う場合は呼び出し元（hook）が await を担う。
    if (!onIdbWork) await waitForPendingIdbSaves();

    const pre = get();
    if (!pre.document || displayIndices.length === 0) return;

    // F-6 (bug-hunt): 待機中にファイル切替/開き直しが起きていたら中止する。
    if (
      !onIdbWork &&
      (useInfraStore.getState().documentEpoch !== entryEpoch || pre.document.filePath !== entryFilePath)
    ) {
      return;
    }

    const capturedFilePath = pre.document.filePath;
    const capturedEpoch = useInfraStore.getState().documentEpoch;

    // PCT-172 (#403): 削除対象のうち LRU 退避済み (in-memory pages Map に無い) ページは
    // beforePages snapshot に含まれず、undo 時に IDB 唯一コピーが既に消えているため
    // 編集内容が永久喪失する。削除実行前に IDB から該当ページを読み戻して snapshot に含める。
    // replaceText (scope='all') の IDB 復元ロジックと同じ組み立て方。
    // 【重要】idbAll の await 中はスナップショットを取らない。await 後に epoch/filePath を
    // 再検証し、改めて live state を snapshot する。これにより (a) 待機中のファイル切替で
    // 旧ドキュメントを新ファイルへ set() してしまう事故、(b) 待機中にコミットされた別ページの
    // 編集 (OCR 等) を stale スナップショットの丸ごと差し替えで消す事故、の両方を防ぐ。
    const preMissing = displayIndices.filter((di) => !pre.document!.pages.has(di));
    let idbAll: Map<string, Partial<PageData>> | null = null;
    if (preMissing.length > 0) {
      idbAll = await getAllTemporaryPageData(capturedFilePath);
      const live = get();
      if (
        useInfraStore.getState().documentEpoch !== capturedEpoch ||
        !live.document ||
        live.document.filePath !== capturedFilePath
      ) {
        return;
      }
    }

    // await 後の最新 state を基準にスナップショットする (以降 set() まで await は無い)。
    const state = get();
    if (!state.document) return;

    const beforeOrder = [...state.pageOrder];
    const beforePages = new Map(state.document.pages);
    const beforeTotalPages = state.document.totalPages;
    const beforeCurrentPageIndex = state.currentPageIndex;

    // 最新 state 基準でまだ in-memory に無い削除対象だけ IDB から snapshot へ読み戻す。
    if (idbAll) {
      const stillMissing = displayIndices.filter((di) => !beforePages.has(di));
      for (const di of stillMissing) {
        const pageId = resolvePageId(beforeOrder, di);
        const partial = idbAll.get(pageId);
        if (!partial || !partial.textBlocks) continue;
        const restored: PageData = {
          pageIndex: di,
          width: partial.width ?? 0,
          height: partial.height ?? 0,
          textBlocks: partial.textBlocks,
          isDirty: partial.isDirty ?? false,
          thumbnail: partial.thumbnail ?? null,
          isTextExtracted: partial.isTextExtracted,
          ocrCleared: partial.ocrCleared,
          rotation: partial.rotation,
          // m3 と同じ流儀: IDB 復元時に pageId を設定する
          pageId: partial.pageId ?? pageId,
        };
        beforePages.set(di, restored);
      }
    }

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
    // #349 (PCT-126): newIdx は afterPages.size (= メモリに存在した生存ページの件数) では
    // なく、survivor の通し位置カウンタで採番する。pages Map は未訪問/LRU退避ページを
    // 欠いた疎 Map なので、afterPages.size を使うと「メモリに無い生存ページ」を挟んだ
    // 後続の在メモリページが本来より前のスロットに詰められる (movePage :638 と同型の修正)。
    const afterPages = new Map<number, PageData>();
    let newIdx = 0;
    beforeOrder.forEach((_, oldDisplayIndex) => {
      if (deleteDisplaySet.has(oldDisplayIndex)) return;
      const page = beforePages.get(oldDisplayIndex);
      if (page) {
        afterPages.set(newIdx, page.pageIndex === newIdx ? page : { ...page, pageIndex: newIdx });
      }
      newIdx++;
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

    // PCT-104 (A-lite 段階3): pageId が不変なため rename sync は不要。
    // 削除された displayIndex の pageId を記録するため set() 前に計算する。
    const filePath = state.document.filePath;
    const deletedPageIndices = beforeOrder.map((_, di) => di).filter((di) => deleteDisplaySet.has(di));

    // Store を更新
    // F-2 (bug-hunt): slice(-100) の先頭トリム件数を計算し、lastSavedActionIndex を追従させる。
    const deleteTrimmedCount = Math.max(0, state.undoStack.length + 1 - 100);
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
        deletedPageIndices,
      }].slice(-100),
      redoStack: [],
      lastSavedActionIndex: adjustLastSavedActionIndexForTrim(state.lastSavedActionIndex, deleteTrimmedCount),
    });

    // PCT-104 (A-lite 段階2): deletePages は set() 後なので pageOrder = afterOrder。
    // 削除された displayIndex の pageId は beforeOrder を使って変換する。
    const deletedPageIds = deletedPageIndices.map((di) => resolvePageId(beforeOrder, di));

    if (onIdbWork) {
      // #254: IDB I/O を hook 層に委譲する（pageId 配列で渡す）
      onIdbWork(filePath, deletedPageIds);
    } else {
      const idbWork = deleteTemporaryPageKeys(filePath, deletedPageIds)
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
    // F-6 (bug-hunt): deletePages と同型。待機前のドキュメント同一性をキャプチャし、
    // 待機中のファイル切替を検知できるようにする。
    const entryFilePath = get().document?.filePath ?? null;
    const entryEpoch = useInfraStore.getState().documentEpoch;
    // PCT-104 (A-lite 段階3): movePage は IDB キー操作不要（pageId 不変）。
    // waitForPendingIdbSaves は念のためそのまま残す（書き込み完了保証）。
    if (!onIdbWork) await waitForPendingIdbSaves();

    const state = get();
    if (!state.document) return;

    // F-6 (bug-hunt): 待機中にファイル切替/開き直しが起きていたら中止する。待機後の
    // state.document が新ファイルに変わっている場合、fromDisplayIndex/toDisplayIndex
    // (旧ファイルの pageOrder 基準) を新ファイルへ誤適用しないようにする。
    if (
      !onIdbWork &&
      (useInfraStore.getState().documentEpoch !== entryEpoch || state.document.filePath !== entryFilePath)
    ) {
      return;
    }

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

    // PCT-104 (A-lite 段階3): pageId が不変なため rename sync は不要。
    const filePath = state.document.filePath;

    // F-2 (bug-hunt): slice(-100) の先頭トリム件数を計算し、lastSavedActionIndex を追従させる。
    const moveTrimmedCount = Math.max(0, state.undoStack.length + 1 - 100);
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
      lastSavedActionIndex: adjustLastSavedActionIndexForTrim(state.lastSavedActionIndex, moveTrimmedCount),
    });

    if (onIdbWork) {
      // #254: IDB I/O を hook 層に委譲する（段階3では rename なし）
      onIdbWork(filePath);
    }
  },

  // issue #207: ページ回転
  // PCT-183 (#414): in-memory に無いページ (未ロード or LRU 退避済み) を無音スキップしていた。
  // LRU 退避済み (IDB に textBlocks あり) は IDB から読み戻して回転を適用する。
  // 本当に未ロード (IDB にも無い) はスキップし、pageIndex を戻り値で呼び出し元へ返す。
  rotatePages: async (pageIndices, delta) => {
    const state = get();
    if (!state.document || pageIndices.length === 0) return { skippedPageIndices: [] };

    const capturedFilePath = state.document.filePath;
    const capturedEpoch = useInfraStore.getState().documentEpoch;
    const basePages = new Map(state.document.pages);
    const missingPageIndices = pageIndices.filter((pi) => !basePages.has(pi));

    // 未ロード/LRU退避ページを IDB から読み戻す (#403/#412 と同じ復元パターン)
    let idbAll: Map<string, Partial<PageData>> | null = null;
    if (missingPageIndices.length > 0) {
      idbAll = await getAllTemporaryPageData(capturedFilePath);
      // epoch/filePath 再検証: getAllTemporaryPageData の await 中にファイル切替が
      // 割り込むと、captured スナップショットを set() して旧ドキュメントで新ファイルを
      // 上書きしてしまう。clearOcrAllPages (PCT-181) と同じ「遅延実行は再検証」規律。
      const live = get();
      if (
        useInfraStore.getState().documentEpoch !== capturedEpoch ||
        !live.document ||
        live.document.filePath !== capturedFilePath
      ) {
        return { skippedPageIndices: pageIndices };
      }
    }

    const changes: RotatePagesAction['changes'] = [];
    const skippedPageIndices: number[] = [];
    // pageIndex → 回転適用後データ。set() 時に live pages へ差分適用する
    // (await 中に別ページへ入った編集 (OCR 等) を丸ごと差し替えで消さないため)。
    const rotatedByIndex = new Map<number, PageData>();
    // LRU 退避から復元したページ (IDB 書き戻し対象)。includes の O(m^2) を避け Set で判定。
    const restoredEvictedIndices = new Set<number>();

    for (const pageIndex of pageIndices) {
      let page = basePages.get(pageIndex);
      let fromEvicted = false;
      if (!page && idbAll) {
        const pageId = resolvePageId(state.pageOrder, pageIndex);
        const partial = idbAll.get(pageId);
        if (partial && partial.textBlocks) {
          page = {
            pageIndex,
            width: partial.width ?? 0,
            height: partial.height ?? 0,
            textBlocks: partial.textBlocks,
            isDirty: partial.isDirty ?? false,
            thumbnail: partial.thumbnail ?? null,
            isTextExtracted: partial.isTextExtracted,
            ocrCleared: partial.ocrCleared,
            rotation: partial.rotation,
            pageId: partial.pageId ?? pageId,
          };
          fromEvicted = true;
        }
      }
      if (!page) {
        skippedPageIndices.push(pageIndex);
        continue;
      }
      const before = (page.rotation ?? 0) as 0 | 90 | 180 | 270;
      // fix(#230): IDB から復元した rotation が NaN や 90 の倍数以外になり得る場合に備え
      // Math.round で最近傍 90 度倍数に丸めてから % 360 する。結果を [0,90,180,270] に強制。
      const raw = (Math.round(before / 90) * 90 + delta) % 360;
      const after = (raw < 0 ? raw + 360 : raw) as 0 | 90 | 180 | 270;
      if (before === after) continue;
      rotatedByIndex.set(pageIndex, { ...page, rotation: after, isDirty: true });
      changes.push({ pageIndex, before, after });
      if (fromEvicted) restoredEvictedIndices.add(pageIndex);
    }

    if (changes.length === 0) return { skippedPageIndices };

    const action: RotatePagesAction = { type: 'rotate_pages', changes };
    set((live) => {
      // await 後にファイル切替が起きていれば適用しない (旧ドキュメント復活の防止)。
      if (!live.document || live.document.filePath !== capturedFilePath) return live;
      const newPages = new Map(live.document.pages);
      for (const [pageIndex, rotated] of rotatedByIndex) {
        // in-memory の最新ページがあれば rotation だけ差し替えて他の編集を保持、
        // 退避ページ (live に無い) は復元データをそのまま入れる。
        const livePage = newPages.get(pageIndex);
        newPages.set(pageIndex, livePage ? { ...livePage, rotation: rotated.rotation, isDirty: true } : rotated);
      }
      // F-2 (bug-hunt): slice(-100) の先頭トリム件数を計算し、lastSavedActionIndex を追従させる。
      const rotateTrimmedCount = Math.max(0, live.undoStack.length + 1 - 100);
      return {
        document: { ...live.document, pages: newPages },
        isDirty: true,
        undoStack: [...live.undoStack, action].slice(-100),
        redoStack: [],
        lastSavedActionIndex: adjustLastSavedActionIndexForTrim(live.lastSavedActionIndex, rotateTrimmedCount),
      };
    });

    // IDB から読み戻して回転したページ (LRU 退避済み) は IDB へも書き戻して同期する。
    // in-memory に元々あったページは他の経路 (保存時の LRU 退避) で書かれるためここでは不要。
    const idbWriteBackEntries = Array.from(rotatedByIndex.entries())
      .filter(([pageIndex]) => restoredEvictedIndices.has(pageIndex))
      .map(([pageIndex, data]) => ({ filePath: capturedFilePath, pageIndex, data }));
    if (idbWriteBackEntries.length > 0) {
      schedulePendingIdbWrite(idbWriteBackEntries, state.pageOrder);
    }

    return { skippedPageIndices };
  },

  setDocumentFilePath: (filePath) => set((state) => {
    if (!state.document) return state;
    const fileName = filePath.split(/[\\/]/).pop() || state.document.fileName;
    return { document: { ...state.document, filePath, fileName } };
  }),

  setDocument: (doc, skipViewerReset = false) => {
    // infraStore から pendingRestoration を取り出してから state をリセットする
    const restoration = useInfraStore.getState().pendingRestoration;

    // PCT-104 (A-lite 段階0): 既存 pages Map の各ページに pageId を付与する。
    // 値は "src:" + pageIndex。pages Map が空の場合（setDocument 後に loadPage で順次ロードされる場合）は
    // loadPage 側で pageId を付与するため、ここではロード済みページのみ対象にする。
    let docWithPageIds = doc;
    if (doc && doc.pages.size > 0) {
      const pagesWithIds = new Map(doc.pages);
      let needsUpdate = false;
      for (const [idx, page] of pagesWithIds.entries()) {
        if (!page.pageId) {
          pagesWithIds.set(idx, { ...page, pageId: `src:${idx}` });
          needsUpdate = true;
        }
      }
      if (needsUpdate) {
        docWithPageIds = { ...doc, pages: pagesWithIds };
      }
    }

    set({
      document: docWithPageIds,
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
          // PCT-104 (A-lite 段階2): restoration のキーは pageIndex の文字列表現。
          // setDocument 直後の pageOrder は [0,1,...,n-1] の連番のため、
          // pageId = "src:" + pageIndex と等しい。resolvePageId を使わず直接組み立てる。
          const entries = Object.entries(restoration).map(([idx, data]) => ({
            filePath: doc.filePath,
            pageId: `src:${parseInt(idx, 10)}`,
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
        pageOrderEquals(state.pageOrder, savedPageOrder);
      if (!matchesSavedOrder) return state;
    }

    const identityOrder = Array.from({ length: doc.totalPages }, (_, i) => i);
    const alreadyIdentity = pageOrderEquals(state.pageOrder, identityOrder);
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
        // F-2 (bug-hunt): 先頭トリムで lastSavedActionIndex も追従させる。
        const trimmedCount = newUndo.length > 100 ? 1 : 0;
        if (trimmedCount > 0) newUndo.shift();
        newState.undoStack = newUndo;
        newState.redoStack = [];
        newState.lastSavedActionIndex = adjustLastSavedActionIndexForTrim(state.lastSavedActionIndex, trimmedCount);
      }

      return newState;
    });

    // set()外でIndexedDB保存をバッチ実行（1トランザクションでまとめて書き込み）
    // pendingIdbSaves に登録して保存処理が完了を待機できるようにする
    if (pendingSaves.length > 0) {
      const saveOcrClearGeneration = ocrClearGeneration;
      // PCT-104 (A-lite 段階2): LRU eviction 時も displayIndex -> pageId 変換して書き込む。
      // idx は displayIndex。pageOrder は set() 後の最新値を取得する。
      const pageOrder = usePecoStore.getState().pageOrder;
      const work = saveTemporaryPageDataBatch(
        pendingSaves.map(({ filePath, idx, page }) => ({
          filePath,
          pageId: resolvePageId(pageOrder, idx),
          data: page,
        }))
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

  resetDirty: (savedPageSnapshots, bytePreserved) => set((state) => {
    if (!state.document) return state;
    // P1-1 (bug-hunt): bytePreserved=true は「保存が byte-preserve 短絡 (undecodable) で
    // 原本バイトをそのまま返した」ことを意味し、このページ群には何も焼き込まれていない
    // (rotation 合成も bbox リベースも content 再描画も一切起きていない)。
    // ここで下の rotation クリア/bbox リベース/isDirty クリアを実行すると、ファイルには
    // 存在しない合成を前提にメモリ上の座標だけを動かしてしまう (90°汚染)。
    // よって bytePreserved のときは savedPageSnapshots を無視し、何も変更せず素通りする。
    if (savedPageSnapshots && bytePreserved) {
      return state;
    }
    // savedPageSnapshots 指定時は「保存スナップショットと同一オブジェクト参照のページ」
    // だけ isDirty を下ろす。保存中に編集されたページは新しいオブジェクト参照になるため
    // 一致せず、その新編集の dirty フラグを巻き込まない (issue #115 / #119)。
    // 省略時は従来通り全ページの isDirty を一律クリアする (後方互換)。
    const newPages = new Map(state.document.pages);
    let anyDirty = false;
    if (savedPageSnapshots) {
      for (const [idx, savedPage] of savedPageSnapshots.entries()) {
        const livePage = newPages.get(idx);
        if (!livePage) continue;
        const isRefMatch = livePage === savedPage;
        // #367 (PCT-144) / P1-2 (bug-hunt): savedPage.rotation は「このページの保存対象
        // (savedPageSnapshots) が実際に buildPdfDocumentCore へ渡ったときの userRotation」
        // であり、pdfSaverCore が「元 /Rotate + savedPage.rotation」を合成して書き込み済み
        // (#352)。呼び出し元 (useFileOperations.ts) は保存直後に setOriginalBytesCache で
        // 保存済みバイトを次回保存の基準にリベースするため、この合成値は次回保存では
        // 「新しい元 /Rotate」として扱われる。
        //
        // P1-2: 参照が不一致 (保存中に別編集が入った) でも、savedPage.rotation が baked
        // されている以上はディスク上の /Rotate には既にその分が反映済み。ここで rotation
        // を放置すると、次回保存時に「新originalRotation(=旧合成値) + stale rotation」が
        // 再度合成され /Rotate がドリフトする (#367 と同型のバグが「参照不一致」経路で
        // 再発する)。よって参照一致・不一致を問わず、savedPage.rotation が baked された
        // 分だけ bbox/rotation をリベースする。isDirty のクリアだけは参照一致時に限る
        // (参照不一致は保存後に新しい編集が入っている＝そのページはまだ dirty のまま
        // 正しく次回保存対象に残す必要がある)。
        const bakedRotation = savedPage.rotation;
        if (bakedRotation !== undefined && bakedRotation !== 0) {
          // リベースは livePage (保存中に編集され得る最新の textBlocks/bbox) に対して行う。
          // livePage の bbox は依然「捕捉フレーム (baked 前)」のままなので、
          // remapBboxForRotation を originalRotation=0 / finalRotation=bakedRotation で
          // 呼べば、PageData.width/height に保持している「捕捉時 viewport 寸法」を
          // そのまま vw0/vh0 として使える。
          const rebasedBlocks = livePage.textBlocks.map((block) => ({
            ...block,
            bbox: remapBboxForRotation(block.bbox, 0, bakedRotation, livePage.width, livePage.height),
          }));
          const swapDims = bakedRotation === 90 || bakedRotation === 270;
          // 参照不一致で、かつ保存中の編集が rotation 自体にも追加で乗っていた場合
          // (livePage.rotation !== savedPage.rotation) に備え、baked 分を差し引いた
          // 残り pending rotation を保持する (通常は参照一致・rotation 未追加なら 0 になり
          // undefined へ収束し、#367 の従来挙動と完全に一致する)。
          const liveRotation = livePage.rotation ?? 0;
          const remainingDelta = normalizeRotation(liveRotation - bakedRotation);
          newPages.set(idx, {
            ...livePage,
            isDirty: isRefMatch ? false : livePage.isDirty,
            rotation: remainingDelta === 0 ? undefined : (remainingDelta as 90 | 180 | 270),
            textBlocks: rebasedBlocks,
            width: swapDims ? livePage.height : livePage.width,
            height: swapDims ? livePage.width : livePage.height,
          });
        } else if (isRefMatch && livePage.isDirty) {
          newPages.set(idx, { ...livePage, isDirty: false, rotation: undefined });
        }
        // else: 参照不一致 かつ rotation 未 baked → 何も焼き込まれていないので触らない
        // (isDirty は既に true のまま維持され、次回保存対象に正しく残る)。
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
    // #365 (PCT-142): order を newBlocks.length ベースで採番すると、削除後の非連続 order
    // (例: [0, 5]) 環境で既存ブロックの order と衝突しうる。既存 order の最大値 + 1 を起点に
    // 採番する (useOcrEngine.ts の範囲 OCR 追記と同じ方針)。
    let nextOrder = newBlocks.reduce((max, b) => Math.max(max, b.order), -1) + 1;

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
        order: nextOrder++,
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
    // F-2 (bug-hunt): 先頭トリムで lastSavedActionIndex も追従させる。
    const trimmedCount = newUndo.length > 100 ? 1 : 0;
    if (trimmedCount > 0) newUndo.shift();
    return {
      undoStack: newUndo,
      redoStack: [],
      lastSavedActionIndex: adjustLastSavedActionIndexForTrim(state.lastSavedActionIndex, trimmedCount),
    };
  }),

  undo: () => {
    const { undoStack, redoStack, document, pageOrder: pageOrderAtAction, lastSavedActionIndex } = get();
    if (undoStack.length === 0 || !document) return;

    const action = undoStack[undoStack.length - 1];
    const newUndo = undoStack.slice(0, -1);
    const newRedo = [action, ...redoStack];
    // #350 (PCT-127): undo で undoStack がチェックポイント (lastSavedActionIndex) を
    // 下回ると、以降 computeSaveDiff の undoStack.slice(lastSavedActionIndex) が常に
    // 空を返し、新しい編集が diff プレビュー/監査ログから漏れる。チェックポイントを
    // 現在の undoStack 長へ追従させて切り下げる (保存対象を減らす方向には作用しない)。
    const newLastSavedActionIndex = Math.min(lastSavedActionIndex, newUndo.length);

    if (action.type === 'update_page') {
      const newPages = new Map(document.pages);
      // #350 (PCT-127): action.before の isDirty をそのまま復元すると、保存を挟んだ
      // undo で「保存フィルタ (p.isDirty) から漏れる」事故になる。rotate_pages の undo
      // と同じく常に isDirty: true を強制する (保存対象が増えるだけで安全側)。
      const restoredPage: PageData = { ...action.before, isDirty: true };
      newPages.set(action.pageIndex, restoredPage);
      const filePath = document.filePath;
      set({
        document: { ...document, pages: newPages },
        undoStack: newUndo,
        redoStack: newRedo,
        lastSavedActionIndex: newLastSavedActionIndex,
        isDirty: true
      });
      // LRU 退避済みページが IDB に残っている可能性があるため、
      // 巻き戻し後の状態を IDB へも書き込んでメモリと完全同期させる。
      // (issue #3: undo が LRU 退避ページの IDB と非整合になる)
      // PCT-108: この action は pageOrder を変えないので action 時点の pageOrder を渡す
      schedulePendingIdbWrite([{ filePath, pageIndex: action.pageIndex, data: restoredPage }], pageOrderAtAction);
    } else if (action.type === 'update_pages') {
      // issue #93: 全ページスコープの置換等で複数ページを atomic に巻き戻す。
      const newPages = new Map(document.pages);
      // #350 (PCT-127): update_page と同様、復元ページは常に isDirty: true にする。
      const restoredEntries = action.entries.map(e => ({
        pageIndex: e.pageIndex,
        data: { ...e.before, isDirty: true } as PageData,
      }));
      for (const e of restoredEntries) {
        newPages.set(e.pageIndex, e.data);
      }
      const filePath = document.filePath;
      set({
        document: { ...document, pages: newPages },
        undoStack: newUndo,
        redoStack: newRedo,
        lastSavedActionIndex: newLastSavedActionIndex,
        isDirty: true,
      });
      // 全 entry を IDB へまとめて同期 (LRU 退避ページがあっても整合性を担保)
      // PCT-108: update_pages は pageOrder を変えないので action 時点の pageOrder を渡す
      schedulePendingIdbWrite(
        restoredEntries.map(e => ({ filePath, pageIndex: e.pageIndex, data: e.data })),
        pageOrderAtAction,
      );
    } else if (action.type === 'delete_pages') {
      // issue #193: ページ削除を巻き戻す (削除前の状態に戻す)
      // #350 (PCT-127) / rotate_pages の undo と対称化: 復元ページは常に isDirty: true
      // を強制する。
      // #437 (PCT-204): #436 は「delete_pages undo 分岐は S-03 正規化により到達不能」と
      // 判定して NOT-A-BUG クローズしたが、保存の非同期区間中に別の構造変更が競合すると
      // normalizePageOrderAfterSave が no-op になり、この分岐へ実際に到達し得ることが
      // #437 で判明した。「到達不能にする」前提を崩さず「到達しても正しい」側へ倒し、
      // isDirty:false のまま復元されたページが保存時の dirty フィルタ (p.isDirty) から
      // 漏れて古い内容のまま保存される事故を防ぐ。
      // レビューMEDIUM対応: 強制対象は「実際に削除されていたページ」(deletedPageIndices)
      // のみに絞る。生存ページの内容は削除前後で不変であり、物理的な存在は pageOrder が
      // 担保する (#436 Test3 で実証済み)。全ページ強制だと 1 ページの delete→undo で
      // byte-preserve 短絡を失い、大ページ数 PDF の保存が全ページ再描画になるため。
      const deletedSet = new Set(action.deletedPageIndices);
      const restoredPages = new Map(
        Array.from(action.beforePages.entries()).map(([pi, page]) =>
          deletedSet.has(pi) ? ([pi, { ...page, isDirty: true }] as const) : ([pi, page] as const),
        ),
      );
      // F-4 (bug-hunt): scheduleRotateUndoRedoIdbWrite と同様、set() 実行時点 (同期) の
      // epoch をキャプチャして渡す (遅延実行中の live 参照は禁止)。
      const capturedEpoch = useInfraStore.getState().documentEpoch;
      set({
        document: {
          ...document,
          pages: restoredPages,
          totalPages: action.beforeTotalPages,
        },
        pageOrder: action.beforeOrder,
        currentPageIndex: action.beforeCurrentPageIndex,
        undoStack: newUndo,
        redoStack: newRedo,
        lastSavedActionIndex: newLastSavedActionIndex,
        isDirty: true,
      });
      // PCT-104 (A-lite 段階3): pageId が不変なため rename 巻き戻し不要。
      // restoredPages (isDirty:true 強制済み) の内容を書き込んで強制同期する。
      // PCT-108: set() で pageOrder は action.beforeOrder に確定済み。その値を渡す。
      scheduleStructuralUndoRedoIdbSync(document.filePath, {
        contentEntries: Array.from(restoredPages.entries()).map(([pi, page]) => ({
          pageIndex: pi,
          data: page,
        })),
        contentPageOrder: action.beforeOrder,
      }, capturedEpoch);
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
        lastSavedActionIndex: newLastSavedActionIndex,
        isDirty: true,
      });
      // PCT-104 (A-lite 段階3): pageId が不変なため rename 巻き戻し不要。
      // reorder_pages の undo では IDB キー操作は発生しない。
      void document.filePath; // eslint lint 対策 (no-op)
    } else if (action.type === 'rotate_pages') {
      // issue #207: ページ回転を巻き戻す (before の角度に戻す)
      const newPages = new Map(document.pages);
      for (const change of action.changes) {
        const page = newPages.get(change.pageIndex);
        if (!page) continue;
        newPages.set(change.pageIndex, { ...page, rotation: change.before, isDirty: true });
      }
      const filePath = document.filePath;
      // PCT-181 (#412 先例): 非同期書き込みが live documentEpoch を読まないよう、
      // set() 実行時点 (同期) の epoch をキャプチャして渡す。
      const capturedEpoch = useInfraStore.getState().documentEpoch;
      set({
        document: { ...document, pages: newPages },
        undoStack: newUndo,
        redoStack: newRedo,
        lastSavedActionIndex: newLastSavedActionIndex,
        isDirty: true,
      });
      // #393 (PCT-162): update_page/update_pages と対称に IDB write-through する。
      // LRU 退避 (in-memory に無い) ページの巻き戻しも無音スキップせず IDB へ同期する。
      // PCT-108: pageOrder は action 時点の値 (pageOrderAtAction) を渡す。
      scheduleRotateUndoRedoIdbWrite(
        filePath,
        action.changes.map((c) => ({ pageIndex: c.pageIndex, rotation: c.before })),
        newPages,
        pageOrderAtAction,
        capturedEpoch,
      );
    }
  },

  redo: () => {
    const { undoStack, redoStack, document, pageOrder: pageOrderAtAction, lastSavedActionIndex } = get();
    if (redoStack.length === 0 || !document) return;

    const action = redoStack[0];
    const newRedo = redoStack.slice(1);
    const newUndo = [...undoStack, action];
    // #350 (PCT-127): redo でも undoStack の長さが変わるため、undo と対称にチェック
    // ポイントを追従させる (通常は newUndo.length が増える方向なので no-op だが、
    // undo で古い分岐へ切り下がった直後の redo でも不変条件 lastSavedActionIndex <=
    // undoStack.length を安全側に保つ)。
    const newLastSavedActionIndex = Math.min(lastSavedActionIndex, newUndo.length);

    if (action.type === 'update_page') {
      const newPages = new Map(document.pages);
      // #350 (PCT-127): undo と対称に、redo で再適用するページも常に isDirty: true を
      // 強制する (rotate_pages の redo と同じ扱い。保存対象が増えるだけで安全側)。
      const restoredPage: PageData = { ...action.after, isDirty: true };
      newPages.set(action.pageIndex, restoredPage);
      const filePath = document.filePath;
      set({
        document: { ...document, pages: newPages },
        undoStack: newUndo,
        redoStack: newRedo,
        lastSavedActionIndex: newLastSavedActionIndex,
        isDirty: true
      });
      // undo と対称: redo 後の状態を IDB へも書き込んで整合性を担保
      // PCT-108: update_page は pageOrder を変えないので action 時点の pageOrder を渡す
      schedulePendingIdbWrite([{ filePath, pageIndex: action.pageIndex, data: restoredPage }], pageOrderAtAction);
    } else if (action.type === 'update_pages') {
      // issue #93: 全ページスコープの置換等で複数ページを atomic にやり直す。
      const newPages = new Map(document.pages);
      // #350 (PCT-127): update_page と同様、再適用ページは常に isDirty: true にする。
      const restoredEntries = action.entries.map(e => ({
        pageIndex: e.pageIndex,
        data: { ...e.after, isDirty: true } as PageData,
      }));
      for (const e of restoredEntries) {
        newPages.set(e.pageIndex, e.data);
      }
      const filePath = document.filePath;
      set({
        document: { ...document, pages: newPages },
        undoStack: newUndo,
        redoStack: newRedo,
        lastSavedActionIndex: newLastSavedActionIndex,
        isDirty: true,
      });
      // PCT-108: update_pages は pageOrder を変えないので action 時点の pageOrder を渡す
      schedulePendingIdbWrite(
        restoredEntries.map(e => ({ filePath, pageIndex: e.pageIndex, data: e.data })),
        pageOrderAtAction,
      );
    } else if (action.type === 'delete_pages') {
      // issue #193: ページ削除をやり直す
      // F-4 (bug-hunt): set() 実行時点 (同期) の epoch をキャプチャして渡す。
      const capturedEpoch = useInfraStore.getState().documentEpoch;
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
        lastSavedActionIndex: newLastSavedActionIndex,
        isDirty: true,
      });
      // PCT-104 (A-lite 段階3): 削除時と同じ IDB キー操作 (delete) を再適用してから
      // afterPages の内容で強制同期する。rename は pageId 不変により不要。
      // deletedPageIndices は action.beforeOrder の displayIndex なので beforeOrder で変換。
      {
        const redoDeletePageIds = (action.deletedPageIndices ?? []).map((di) =>
          resolvePageId(action.beforeOrder, di)
        );
        // PCT-108: set() で pageOrder は action.afterOrder に確定済み。その値を渡す。
        scheduleStructuralUndoRedoIdbSync(document.filePath, {
          deletePageIds: redoDeletePageIds,
          contentEntries: Array.from(action.afterPages.entries()).map(([pi, page]) => ({
            pageIndex: pi,
            data: page,
          })),
          contentPageOrder: action.afterOrder,
        }, capturedEpoch);
      }
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
        lastSavedActionIndex: newLastSavedActionIndex,
        isDirty: true,
      });
      // PCT-104 (A-lite 段階3): pageId が不変なため rename 再適用不要。
      // reorder_pages の redo では IDB キー操作は発生しない。
      void document.filePath; // eslint lint 対策 (no-op)
    } else if (action.type === 'rotate_pages') {
      // issue #207: ページ回転をやり直す (after の角度に進める)
      const newPages = new Map(document.pages);
      for (const change of action.changes) {
        const page = newPages.get(change.pageIndex);
        if (!page) continue;
        newPages.set(change.pageIndex, { ...page, rotation: change.after, isDirty: true });
      }
      const filePath = document.filePath;
      // PCT-181 (#412 先例): 非同期書き込みが live documentEpoch を読まないよう、
      // set() 実行時点 (同期) の epoch をキャプチャして渡す。
      const capturedEpoch = useInfraStore.getState().documentEpoch;
      set({
        document: { ...document, pages: newPages },
        undoStack: newUndo,
        redoStack: newRedo,
        lastSavedActionIndex: newLastSavedActionIndex,
        isDirty: true,
      });
      // #393 (PCT-162): undo と対称に IDB write-through する。
      // PCT-108: pageOrder は action 時点の値 (pageOrderAtAction) を渡す。
      scheduleRotateUndoRedoIdbWrite(
        filePath,
        action.changes.map((c) => ({ pageIndex: c.pageIndex, rotation: c.after })),
        newPages,
        pageOrderAtAction,
        capturedEpoch,
      );
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
    const { document, pageOrder } = get();
    if (!document) return;
    const filePath = document.filePath;
    const totalPages = document.totalPages;
    // PCT-181 (#412): 遅延 IDB 書き込みが live getState() を読まないよう、
    // set() 実行時点 (同期) の pageOrder / クリア後ページを呼び出し元でキャプチャして渡す。
    // documentEpoch も同様にキャプチャし、実行時にファイル切替が起きていたら no-op にする。
    const capturedPageOrder = pageOrder;
    const capturedEpoch = useInfraStore.getState().documentEpoch;
    ocrClearGeneration += 1;
    // perf(#241): totalPages 件の空 PageData を生成する代わりに、
    // in-memory に存在するページのみを走査して textBlocks を空にする。
    // LRU で退避済みページ (Map に無いもの) は IDB に空 OCR 状態を書いて同期する。
    const newPages = new Map<number, PageData>();
    for (const [idx, page] of document.pages.entries()) {
      newPages.set(idx, clearedOcrPage(idx, page));
    }
    set((state) => {
      if (!state.document) return state;
      return {
        document: { ...state.document, pages: newPages },
        isDirty: true,
        undoStack: [],
        redoStack: [],
        // SH-6 (#431 / PCT-200): undoStack を [] にリセットするなら lastSavedActionIndex も
        // setDocument (622行目付近) と対称に 0 へリセットする。据え置くと次の保存の
        // diff プレビュー確認が古い index を基準に判定され、1 回無言スキップされる。
        lastSavedActionIndex: 0,
      };
    });
    scheduleClearOcrAllPagesIdbWrite(filePath, totalPages, newPages, capturedPageOrder, capturedEpoch);
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
    // #394 (PCT-163): entry 時点の pageOrder をキャプチャし、以降の IDB read await 中に
    // movePage 等が割り込んでも entries の displayIndex 解決と IDB write を同一体系で行う。
    // PCT-108 と同じ「遅延 getState 参照禁止」規律を、await 直後の live 参照にも適用する。
    const pageOrderAtEntry = state.pageOrder;
    // F-1 (bug-hunt): scope='all' の getAllTemporaryPageData await 中にファイル切替が
    // 起きても検知できるよう、entry 時点の documentEpoch をキャプチャする。
    // deletePages/rotatePages と同型の「await直後に epoch+filePath 再検証」に使う。
    const capturedEpoch = useInfraStore.getState().documentEpoch;

    // 検索用の RegExp を組み立てる。useRegex=false は escape して flag 'g' を必ず付ける。
    // #338 (PCT-115): useRegex=true の構文エラーは throw せず catch し、安全な戻り値
    // (hits:0 + regexError) を返す。replaceTextBatch の invalidRuleIndices と対称な
    // store 層 defense-in-depth。UI 層 (useFindReplace の regexError) が一次防御だが、
    // 呼び出し元の実装変更に脆くならないよう二層目として構文エラーを吸収する。
    const flags = `g${caseSensitive ? '' : 'i'}`;
    let re: RegExp;
    try {
      re = useRegex
        ? new RegExp(pattern, flags)
        : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    } catch (e) {
      return {
        hits: 0,
        blocks: 0,
        pages: 0,
        skippedBlocks: 0,
        regexError: e instanceof Error ? e.message : String(e),
      };
    }

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
      // PCT-104 (A-lite 段階2): IDB から退避ページを読み戻し、in-memory に無い idx だけ追加。
      // getAllTemporaryPageData は Map<pageId, data> を返すので resolveDisplayIndex で変換する。
      const idbAll = await getAllTemporaryPageData(filePath);
      // F-1 (bug-hunt): await 中にファイル切替/開き直しが起きていたら中止する。
      // deletePages/rotatePages と同型の epoch+filePath 再検証。中止しないと、
      // この後の set() が旧ドキュメント基準の entries (この idbAll を含む) を
      // 新ドキュメントの pages Map にそのまま適用し、別ファイルの内容を汚染する。
      const liveAfterIdbRead = get();
      if (
        useInfraStore.getState().documentEpoch !== capturedEpoch ||
        !liveAfterIdbRead.document ||
        liveAfterIdbRead.document.filePath !== filePath
      ) {
        return { hits: 0, blocks: 0, pages: 0, skippedBlocks: 0 };
      }
      // #394 (PCT-163): entry 時点のスナップショットで解決する (live state.pageOrder は不可)。
      const pageOrderForResolve = pageOrderAtEntry;
      for (const [pageId, partial] of idbAll.entries()) {
        const idx = resolveDisplayIndex(pageOrderForResolve, pageId);
        if (idx < 0) continue;
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
          // m3: IDB 復元時に pageId を設定する（IDB キー解決を安全に行うため）
          pageId: partial.pageId ?? pageId,
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
      // F-1 (bug-hunt): entries は capturedEpoch/filePath 時点のドキュメントを基準に
      // 組み立てた差分。set() 実行時点で別ファイルに切り替わっていたら適用しない。
      if (!s.document || s.document.filePath !== filePath) return s;
      const newPages = new Map(s.document.pages);
      for (const e of entries) {
        // 退避済みページの after も in-memory に積む (LRU で再度退避され得る)
        newPages.set(e.pageIndex, e.after);
      }
      const newAction: Action = { type: 'update_pages', entries };
      const newUndo = [...s.undoStack, newAction];
      // F-2 (bug-hunt): 先頭トリムで lastSavedActionIndex も追従させる。
      const trimmedCount = newUndo.length > 100 ? 1 : 0;
      if (trimmedCount > 0) newUndo.shift();
      return {
        document: { ...s.document, pages: newPages },
        undoStack: newUndo,
        redoStack: [],
        isDirty: true,
        lastSavedActionIndex: adjustLastSavedActionIndexForTrim(s.lastSavedActionIndex, trimmedCount),
      };
    });

    // LRU 退避済みページの IDB と整合させるため、変更ページ全部を IDB にも書き込む
    // #394 (PCT-163): entries の pageIndex は pageOrderAtEntry 体系で解決済みのため、
    // 書き込みも同じ pageOrderAtEntry を使う。get().pageOrder (live) を使うと、
    // 冒頭の getAllTemporaryPageData await 中に movePage が割り込んだ場合、
    // entries 解決時の pageOrder と書き込み時の pageOrder が食い違い、
    // resolvePageId が別ページの pageId に誤マップする (PCT-108 違反)。
    schedulePendingIdbWrite(
      entries.map(e => ({ filePath, pageIndex: e.pageIndex, data: e.after })),
      pageOrderAtEntry,
    );

    return { hits: totalHits, blocks: totalBlocks, pages: entries.length, skippedBlocks };
  },

  // issue #213: 1-pass batch replace
  replaceTextBatch: async (rules, scope) => {
    const state = get();
    const document = state.document;
    if (!document) return { totalHits: 0, perRuleHits: rules.map(() => 0), invalidRuleIndices: [] };
    if (rules.length === 0) return { totalHits: 0, perRuleHits: [], invalidRuleIndices: [] };
    // #394 (PCT-163): replaceText と同様、entry 時点の pageOrder をキャプチャして
    // entries 解決と IDB write の両方で一貫して使う (live state.pageOrder は不可)。
    const pageOrderAtEntry = state.pageOrder;
    // F-1 (bug-hunt): replaceText と同型。scope='all' の getAllTemporaryPageData await
    // 中にファイル切替が起きても検知できるよう、entry 時点の documentEpoch をキャプチャする。
    const capturedEpoch = useInfraStore.getState().documentEpoch;

    // 各ルールの RegExp と置換文字列を事前にコンパイルする (1 度だけ生成して使い回す)
    // perf(#223): isRegex=true の後方参照解決用 non-global 版も outer scope で 1 度だけ生成する
    //
    // 不正な正規表現 (isRegex=true でコンパイル失敗) は throw させず null にして
    // invalidRuleIndices に記録する。UI 層で検証済みの想定だが、ここでも防御する
    // ことで 1 ルールの不正が同一バッチ内の他ルールを巻き添えにしないようにする。
    type CompiledRule = {
      re: RegExp;
      safeReplacement: string;
      isRegex: boolean;
      literalReplacement: string;
      oneShotRe: RegExp | null;
    };
    const invalidRuleIndices: number[] = [];
    const compiledRules: Array<CompiledRule | null> = rules.map((rule, i) => {
      const flags = `g${rule.caseSensitive ? '' : 'i'}`;
      let re: RegExp;
      try {
        re = rule.isRegex
          ? new RegExp(rule.pattern, flags)
          : new RegExp(rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      } catch {
        invalidRuleIndices.push(i);
        return null;
      }
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
      // PCT-104 (A-lite 段階2): getAllTemporaryPageData は Map<pageId, data> を返す。
      const idbAll = await getAllTemporaryPageData(filePath);
      // F-1 (bug-hunt): await 中にファイル切替/開き直しが起きていたら中止する。
      // replaceText と同型の epoch+filePath 再検証 (中止しないと旧ドキュメント基準の
      // entries をこの後 set() で新ドキュメントに誤適用してしまう)。
      const liveAfterIdbRead = get();
      if (
        useInfraStore.getState().documentEpoch !== capturedEpoch ||
        !liveAfterIdbRead.document ||
        liveAfterIdbRead.document.filePath !== filePath
      ) {
        return { totalHits: 0, perRuleHits: rules.map(() => 0), invalidRuleIndices };
      }
      // #394 (PCT-163): entry 時点のスナップショットで解決する (live state.pageOrder は不可)。
      const pageOrderForResolve = pageOrderAtEntry;
      for (const [pageId, partial] of idbAll.entries()) {
        const idx = resolveDisplayIndex(pageOrderForResolve, pageId);
        if (idx < 0) continue;
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
          // m3: IDB 復元時に pageId を設定する（IDB キー解決を安全に行うため）
          pageId: partial.pageId ?? pageId,
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
          const compiled = compiledRules[ri];
          if (!compiled) continue; // 不正な正規表現ルールはスキップ (invalidRuleIndices で通知済み)
          const { re, safeReplacement, isRegex, literalReplacement, oneShotRe } = compiled;
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
      return { totalHits: 0, perRuleHits, invalidRuleIndices };
    }

    // store に反映し、undoStack に 1 entry だけ積む
    set((s) => {
      // F-1 (bug-hunt): entries は capturedEpoch/filePath 時点のドキュメントを基準に
      // 組み立てた差分。set() 実行時点で別ファイルに切り替わっていたら適用しない。
      if (!s.document || s.document.filePath !== filePath) return s;
      const newPages = new Map(s.document.pages);
      for (const e of entries) {
        newPages.set(e.pageIndex, e.after);
      }
      const newAction: Action = { type: 'update_pages', entries };
      const newUndo = [...s.undoStack, newAction];
      // F-2 (bug-hunt): 先頭トリムで lastSavedActionIndex も追従させる。
      const trimmedCount = newUndo.length > 100 ? 1 : 0;
      if (trimmedCount > 0) newUndo.shift();
      return {
        document: { ...s.document, pages: newPages },
        undoStack: newUndo,
        redoStack: [],
        isDirty: true,
        lastSavedActionIndex: adjustLastSavedActionIndexForTrim(s.lastSavedActionIndex, trimmedCount),
      };
    });

    // IDB 書き込みは変更ページのみ 1 度ずつ
    // #394 (PCT-163): replaceText と同様、entries 解決に使った pageOrderAtEntry で書く。
    // get().pageOrder (live) は冒頭の IDB read await 中の movePage 割込みで
    // entries 解決時点の pageOrder と食い違い、書き込み先 pageId がずれる。
    schedulePendingIdbWrite(
      entries.map(e => ({ filePath, pageIndex: e.pageIndex, data: e.after })),
      pageOrderAtEntry,
    );

    return { totalHits, perRuleHits, invalidRuleIndices };
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
