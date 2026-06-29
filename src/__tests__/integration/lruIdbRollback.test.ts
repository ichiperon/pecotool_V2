/**
 * LRU 退避書込失敗 → ロールバック の回帰テスト
 *
 * 検証観点:
 *   B-1. IDB 書込失敗時、LRU で退避したページがメモリに復元される（ロールバック発火）
 *   B-2. 復元されたページは isDirty=true のまま（保存対象に残る）
 *   B-3. infraStore.lastIdbError にエラーが記録される
 *   B-4. 対比: IDB 書込成功時はページがメモリから退避されたまま（復元されない）
 *
 * 実装方針:
 *   - FailingDirtyTransactionDatabase（pdfTemporaryStorageBoundary.test.ts と同型）で
 *     IDB の temporary_changes トランザクションを throw させる。
 *   - pecoStore / pdfTemporaryStorage を vi.resetModules() でリフレッシュしてから
 *     dynamic import で取得し、テスト間の IDB 注入が干渉しないようにする。
 *   - pecoStore.updatePageData を MAX_CACHED_PAGES+1 回呼び出して LRU 退避を発火。
 *   - waitForPendingIdbSaves() で IDB の async work が決着するのを待ってからアサート。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Tauri / pdfjs / bitmapCache は pecoStore の起動に必要なため常時 mock ──────
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (p: string) => p }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  stat: vi.fn().mockResolvedValue({ mtime: Date.now() }),
}));
vi.mock('../../utils/bitmapCache', () => ({ clearBitmapCache: vi.fn() }));
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

// ── Fake IDB infrastructure (pdfTemporaryStorageBoundary.test.ts と同型) ───────

type FakeRequest<T> = IDBRequest<T> & {
  result: T;
  error: DOMException | null;
  onsuccess: ((this: IDBRequest<T>, ev: Event) => unknown) | null;
  onerror: ((this: IDBRequest<T>, ev: Event) => unknown) | null;
  onupgradeneeded?:
    | ((this: IDBOpenDBRequest, ev: IDBVersionChangeEvent) => unknown)
    | null;
};

function makeRequest<T>(result: T): FakeRequest<T> {
  return { result, error: null, onsuccess: null, onerror: null } as FakeRequest<T>;
}

class FakeTransaction {
  oncomplete: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  onerror: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  onabort: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  error: DOMException | null = null;
  private completed = false;

  constructor(private readonly data: Map<string, unknown>) {}

  objectStore(): IDBObjectStore {
    return new FakeObjectStore(this.data, this) as unknown as IDBObjectStore;
  }

  completeSoon(): void {
    if (this.completed) return;
    this.completed = true;
    queueMicrotask(() =>
      this.oncomplete?.call(
        this as unknown as IDBTransaction,
        new Event('complete'),
      ),
    );
  }
}

class FakeObjectStore {
  constructor(
    private readonly data: Map<string, unknown>,
    private readonly tx: FakeTransaction,
  ) {}

  put(value: unknown, key: IDBValidKey): IDBRequest<IDBValidKey> {
    const request = makeRequest<IDBValidKey>(key);
    this.data.set(String(key), value);
    this.tx.completeSoon();
    return request;
  }

  delete(key: IDBValidKey): IDBRequest<undefined> {
    const request = makeRequest<undefined>(undefined);
    this.data.delete(String(key));
    this.tx.completeSoon();
    return request;
  }

  get(key: IDBValidKey): IDBRequest<unknown> {
    const request = makeRequest<unknown>(undefined);
    queueMicrotask(() => {
      request.result = this.data.get(String(key));
      request.onsuccess?.call(request, new Event('success'));
      this.tx.completeSoon();
    });
    return request;
  }

  openCursor(): IDBRequest<null> {
    const request = makeRequest<null>(null);
    queueMicrotask(() => {
      request.onsuccess?.call(request, new Event('success'));
      this.tx.completeSoon();
    });
    return request as unknown as IDBRequest<null>;
  }
}

class FakeDatabase {
  readonly stores = new Map<string, Map<string, unknown>>();
  readonly objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  } as DOMStringList;

  onclose: (() => void) | null = null;
  onversionchange: (() => void) | null = null;

  createObjectStore(name: string): IDBObjectStore {
    const store = new Map<string, unknown>();
    this.stores.set(name, store);
    return new FakeObjectStore(store, new FakeTransaction(store)) as unknown as IDBObjectStore;
  }

  transaction(name: string): IDBTransaction {
    const store = this.stores.get(name);
    if (!store) throw new Error(`missing store: ${name}`);
    return new FakeTransaction(store) as unknown as IDBTransaction;
  }

  close(): void {
    this.onclose?.();
  }
}

class FailingDirtyTransactionDatabase extends FakeDatabase {
  constructor(private readonly message: string) {
    super();
  }

  transaction(name: string): IDBTransaction {
    if (name === 'temporary_changes') throw new Error(this.message);
    return super.transaction(name);
  }
}

let originalIndexedDB: IDBFactory | undefined;
let originalIDBKeyRange: typeof IDBKeyRange | undefined;

function setupFakeIdb(db: FakeDatabase): void {
  const holder = globalThis as unknown as {
    indexedDB: IDBFactory;
    IDBKeyRange: typeof IDBKeyRange;
  };
  holder.indexedDB = {
    open: vi.fn(() => {
      const request = makeRequest(db) as unknown as IDBOpenDBRequest &
        FakeRequest<FakeDatabase>;
      queueMicrotask(() => {
        request.onupgradeneeded?.call(
          request,
          new Event('upgradeneeded') as IDBVersionChangeEvent,
        );
        request.onsuccess?.call(request, new Event('success'));
      });
      return request;
    }),
  } as unknown as IDBFactory;
  holder.IDBKeyRange = {
    bound: (lower: string, upper: string) =>
      ({ lower, upper, lowerOpen: false, upperOpen: false }) as unknown as IDBKeyRange,
  } as unknown as typeof IDBKeyRange;
}

// ── Test helpers ──────────────────────────────────────────────────────────────

import type { PageData, PecoDocument } from '../../types';

function makePageData(pageIndex: number): PageData {
  return {
    pageIndex,
    pageId: `src:${pageIndex}`,
    width: 595,
    height: 842,
    textBlocks: [
      {
        id: `blk-${pageIndex}`,
        text: `page-${pageIndex}-text`,
        originalText: `page-${pageIndex}-text`,
        bbox: { x: 10, y: 10, width: 100, height: 20 },
        writingMode: 'horizontal',
        order: 0,
        isNew: false,
        isDirty: true,
      },
    ],
    isDirty: true,
    thumbnail: null,
  };
}

function makeDocument(totalPages: number): PecoDocument {
  const pages = new Map<number, PageData>();
  for (let i = 0; i < totalPages; i++) {
    pages.set(i, makePageData(i));
  }
  return {
    filePath: 'test-rollback.pdf',
    fileName: 'test-rollback.pdf',
    totalPages,
    metadata: {},
    pages,
  };
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetModules();
  originalIndexedDB = (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB;
  originalIDBKeyRange = (globalThis as unknown as { IDBKeyRange?: typeof IDBKeyRange }).IDBKeyRange;
});

afterEach(() => {
  vi.restoreAllMocks();
  const holder = globalThis as unknown as {
    indexedDB?: IDBFactory;
    IDBKeyRange?: typeof IDBKeyRange;
  };
  if (originalIndexedDB !== undefined) {
    holder.indexedDB = originalIndexedDB;
  } else {
    delete holder.indexedDB;
  }
  if (originalIDBKeyRange !== undefined) {
    holder.IDBKeyRange = originalIDBKeyRange;
  } else {
    delete holder.IDBKeyRange;
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LRU 退避書込失敗 → ロールバック（pecoStore レベル）', () => {
  /**
   * B-1/B-2/B-3: IDB 書込失敗時、退避ページがメモリに復元され isDirty のまま残る。
   */
  it('IDB 書込失敗時に LRU 退避ページがメモリに復元され isDirty=true が維持される', async () => {
    // IDB の temporary_changes トランザクションを常に throw する DB をセット
    setupFakeIdb(new FailingDirtyTransactionDatabase('idb write failed for rollback test'));

    // vi.resetModules() 後に pecoStore / pdfTemporaryStorage / infraStore をリフレッシュして取得
    // infraStore も同じ reset サイクルで import しないと setLastIdbError が別インスタンスに向く
    const { usePecoStore, MAX_CACHED_PAGES, waitForPendingIdbSaves } =
      await import('../../store/pecoStore');
    const { useInfraStore } = await import('../../store/infraStore');

    // MAX_CACHED_PAGES + 1 ページのドキュメントをセット（LRU 退避が発火する最小ページ数）
    const TOTAL = MAX_CACHED_PAGES + 1;
    const doc = makeDocument(TOTAL);

    usePecoStore.setState({
      document: doc,
      pageOrder: Array.from({ length: TOTAL }, (_, i) => i),
      currentPageIndex: 0,
      isDirty: false,
      selectedIds: new Set<string>(),
      undoStack: [],
      redoStack: [],
      lastSavedActionIndex: 0,
    } as any);

    // 全ページを順次 updatePageData（ページ 0 → TOTAL-1 の順で更新）
    // → 最後に更新されたページが最新アクセスになり、最初のページが LRU 退避対象になる
    const store = usePecoStore.getState();
    for (let i = 0; i < TOTAL; i++) {
      store.updatePageData(
        i,
        {
          textBlocks: makePageData(i).textBlocks,
          isDirty: true,
        },
        false,
      );
    }

    // LRU 退避の IDB async work が完了（＝失敗して catch まで到達）するのを待つ
    await waitForPendingIdbSaves();

    // ── アサート B-1: 退避対象ページがメモリに復元されている ──────────────
    // IDB 書込失敗 → catch → set() でメモリ復元のため、
    // 全ページが document.pages Map に存在するはず（退避後も元に戻る）
    const afterState = usePecoStore.getState();
    expect(afterState.document).not.toBeNull();

    // LRU 退避が発動するには TOTAL > MAX_CACHED_PAGES が必要
    // 退避発動後にロールバックが起きていれば全ページが復元される
    const pagesInMemory = afterState.document!.pages;

    // 退避→IDB失敗→ロールバックの本質的不変則は「退避されたページが復元され、1ページも
    // 失われない」こと。currentPageIndex=0 のページ0は「Never purge the current page」
    // (pecoStore.ts) で退避保護され常駐するため、has(0) では検出力がゼロ（ロールバックを
    // 丸ごと削っても通る）。実際に退避→復元されるのは非current の最古ページ(page1)。
    // 喪失ゼロ = size===TOTAL でロールバック復元を固定する（復元を削ると size=TOTAL-1 で赤）。
    expect(pagesInMemory.size).toBe(TOTAL);

    // 退避された非currentページ(page1)が復元され、保存対象として dirty を維持している
    expect(pagesInMemory.has(1)).toBe(true);
    const restoredPage = pagesInMemory.get(1)!;

    // ── アサート B-2: 復元されたページは isDirty=true（保存対象に残る）──
    expect(restoredPage.isDirty).toBe(true);

    // ── アサート B-3: infraStore.lastIdbError にエラーが記録されている ──
    const lastError = useInfraStore.getState().lastIdbError;
    expect(lastError).not.toBeNull();
    expect(lastError?.message).toContain('idb write failed for rollback test');
  }, 30_000);

  /**
   * B-4: 対比テスト — IDB 書込成功時はページがメモリから退避されたまま（復元されない）。
   * ロールバックが失敗時限定であることを固定する。
   */
  it('IDB 書込成功時は LRU 退避ページがメモリから除去されたまま（ロールバックは発生しない）', async () => {
    // 正常な FakeDatabase をセット（書込成功）
    setupFakeIdb(new FakeDatabase());

    const { usePecoStore, MAX_CACHED_PAGES, waitForPendingIdbSaves } =
      await import('../../store/pecoStore');
    const { useInfraStore } = await import('../../store/infraStore');

    const TOTAL = MAX_CACHED_PAGES + 1;
    const doc = makeDocument(TOTAL);

    usePecoStore.setState({
      document: doc,
      pageOrder: Array.from({ length: TOTAL }, (_, i) => i),
      currentPageIndex: 0,
      isDirty: false,
      selectedIds: new Set<string>(),
      undoStack: [],
      redoStack: [],
      lastSavedActionIndex: 0,
    } as any);

    const store = usePecoStore.getState();
    for (let i = 0; i < TOTAL; i++) {
      store.updatePageData(
        i,
        {
          textBlocks: makePageData(i).textBlocks,
          isDirty: true,
        },
        false,
      );
    }

    await waitForPendingIdbSaves();

    const afterState = usePecoStore.getState();
    expect(afterState.document).not.toBeNull();

    // 書込成功 → ロールバックなし → メモリのページ数は MAX_CACHED_PAGES 以下
    const pagesInMemory = afterState.document!.pages;
    expect(pagesInMemory.size).toBeLessThanOrEqual(MAX_CACHED_PAGES);

    // IDB エラーは記録されていない
    const lastError = useInfraStore.getState().lastIdbError;
    expect(lastError).toBeNull();
  }, 30_000);
});
