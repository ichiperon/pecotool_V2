/**
 * Test gap fill wave 4:
 * pdfTemporaryStorage 境界値テスト
 *
 * 検証観点:
 *   1. 大量データ (5000 エントリ) の getAllTemporaryPageData が timeout 内に完了
 *   2. saveTemporaryPageDataBatch を Promise.all で並列実行しても IDB の整合性が維持される
 *   3. DB が一度 close した後に openDB で再接続 (dbPromise=null リセット動作確認)
 *   4. 同一 filePath + 同 pageIndex で 2 回書き込みすると後勝ちになる
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageData } from '../../types';

// ── Fake IDB infrastructure (既存テストの FakeDatabase を拡張) ────────────

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

  constructor(
    private readonly data: Map<string, unknown>,
    private readonly withRange: boolean = true,
  ) {}

  objectStore(): IDBObjectStore {
    return new FakeObjectStore(
      this.data,
      this,
      this.withRange,
    ) as unknown as IDBObjectStore;
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

/**
 * IDBKeyRange.bound のフィルタリングをエミュレートする FakeCursor。
 * 既存テストの FakeCursor はフィルタリングなし (全件返却) だが、
 * getAllTemporaryPageData は IDBKeyRange.bound(prefix, prefix+￿) を使う。
 * ここでは filePath prefix フィルタを適用した entries をあらかじめ渡す形で対応する。
 */
class FakeCursor {
  constructor(
    private readonly entries: Array<[string, unknown]>,
    private index: number,
    private readonly data: Map<string, unknown>,
    private readonly request: FakeRequest<FakeCursor | null>,
    private readonly tx: FakeTransaction,
  ) {}

  get key(): IDBValidKey {
    return this.entries[this.index][0];
  }

  get value(): unknown {
    return this.entries[this.index][1];
  }

  continue(): void {
    this.index++;
    queueMicrotask(() =>
      dispatchCursor(this.entries, this.index, this.data, this.request, this.tx),
    );
  }

  delete(): void {
    this.data.delete(String(this.key));
  }
}

class FakeObjectStore {
  constructor(
    private readonly data: Map<string, unknown>,
    private readonly tx: FakeTransaction,
    private readonly withRange: boolean = true,
  ) {}

  get(key: IDBValidKey): IDBRequest<unknown> {
    const request = makeRequest<unknown>(undefined);
    queueMicrotask(() => {
      request.result = this.data.get(String(key));
      request.onsuccess?.call(request, new Event('success'));
      this.tx.completeSoon();
    });
    return request;
  }

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

  /**
   * openCursor はオプションの range 引数を受け取る。
   * IDBKeyRange.bound が渡された場合は lower/upper で prefix フィルタリングする。
   */
  openCursor(range?: IDBKeyRange | null): IDBRequest<FakeCursor | null> {
    const request = makeRequest<FakeCursor | null>(null);
    let entries = Array.from(this.data.entries());

    // prefix フィルタリング (IDBKeyRange.bound に相当)
    if (range && this.withRange) {
      const lower = (range as unknown as { lower?: string }).lower ?? '';
      const upper = (range as unknown as { upper?: string }).upper ?? '￿';
      entries = entries.filter(([k]) => k >= lower && k <= upper);
    }

    queueMicrotask(() =>
      dispatchCursor(entries, 0, this.data, request, this.tx),
    );
    return request as unknown as IDBRequest<FakeCursor | null>;
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
    return new FakeObjectStore(
      store,
      new FakeTransaction(store),
    ) as unknown as IDBObjectStore;
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

function dispatchCursor(
  entries: Array<[string, unknown]>,
  index: number,
  data: Map<string, unknown>,
  request: FakeRequest<FakeCursor | null>,
  tx: FakeTransaction,
): void {
  request.result =
    index < entries.length
      ? new FakeCursor(entries, index, data, request, tx)
      : null;
  request.onsuccess?.call(request, new Event('success'));
  if (!request.result) tx.completeSoon();
}

// IDBKeyRange は jsdom でも available だが fake 実装でも動くよう shim
function makeFakeIdbKeyRange(lower: string, upper: string): IDBKeyRange {
  return { lower, upper, lowerOpen: false, upperOpen: false } as unknown as IDBKeyRange;
}

// ── Test infrastructure ───────────────────────────────────────────────────

let originalIndexedDB: IDBFactory | undefined;
let originalIDBKeyRange: typeof IDBKeyRange | undefined;
let fakeDb: FakeDatabase;

function setupFakeIdb(db?: FakeDatabase): void {
  fakeDb = db ?? new FakeDatabase();
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = {
    open: vi.fn(() => {
      const request = makeRequest(fakeDb) as unknown as IDBOpenDBRequest &
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

  // IDBKeyRange.bound を fake 化
  ;(globalThis as unknown as { IDBKeyRange: typeof IDBKeyRange }).IDBKeyRange =
    {
      bound: (lower: string, upper: string) => makeFakeIdbKeyRange(lower, upper),
    } as unknown as typeof IDBKeyRange;
}

beforeEach(() => {
  vi.resetModules();
  originalIndexedDB = globalThis.indexedDB;
  originalIDBKeyRange = globalThis.IDBKeyRange;
  vi.spyOn(Date, 'now').mockImplementation(() => 0);
  setupFakeIdb();
});

afterEach(() => {
  vi.restoreAllMocks();
  const holder = globalThis as unknown as {
    indexedDB?: IDBFactory;
    IDBKeyRange?: typeof IDBKeyRange;
  };
  if (originalIndexedDB) {
    holder.indexedDB = originalIndexedDB;
  } else {
    delete holder.indexedDB;
  }
  if (originalIDBKeyRange) {
    holder.IDBKeyRange = originalIDBKeyRange;
  } else {
    delete holder.IDBKeyRange;
  }
});

function makePartialPage(pageIndex: number, textCount = 1): Partial<PageData> {
  return {
    pageIndex,
    width: 595,
    height: 842,
    textBlocks: Array.from({ length: textCount }, (_, i) => ({
      id: `blk-${pageIndex}-${i}`,
      text: `text-${pageIndex}-${i}`,
      isDirty: true,
    })) as PageData['textBlocks'],
    isDirty: true,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('pdfTemporaryStorage 境界値 (wave 4)', () => {
  // ── 境界値 1: 大量エントリ (5000件) の getAllTemporaryPageData ────────

  it('5000 件の temporary_changes エントリを getAllTemporaryPageData が timeout 内に返す', async () => {
    const { saveTemporaryPageDataBatch, getAllTemporaryPageData } =
      await import('../../utils/pdfTemporaryStorage');

    const FILE_PATH = 'large-batch.pdf';
    const N = 5000;

    // 5000 件を一括書き込み (PCT-104: pageId 形式 "src:N")
    const entries = Array.from({ length: N }, (_, i) => ({
      filePath: FILE_PATH,
      pageId: `src:${i}`,
      data: makePartialPage(i),
    }));
    await saveTemporaryPageDataBatch(entries);

    // fake IDB の temporary_changes ストアにデータが入っていることを確認
    const store = fakeDb.stores.get('temporary_changes');
    expect(store?.size).toBe(N);

    // 全件取得が完了する (timeout による hang なし)
    const start = Date.now();
    const result = await getAllTemporaryPageData(FILE_PATH);
    const elapsed = Date.now() - start;

    // 5000 件が全て返ってくる (PCT-104: キーは pageId 文字列 "src:N")
    expect(result.size).toBe(N);
    for (let i = 0; i < N; i++) {
      expect(result.has(`src:${i}`), `pageId src:${i} が result に含まれること`).toBe(true);
    }
    // 1 分未満で完了 (テスト環境の制約でゆるめに設定)
    expect(elapsed).toBeLessThan(60_000);
  }, 90_000);

  // ── 境界値 2: 同時書き込み (Promise.all 並列) ────────────────────────

  it('saveTemporaryPageDataBatch を Promise.all で並列実行しても最終データが揃っている', async () => {
    // 注意: 実際の IDB はトランザクション分離を保証するが、
    // fake IDB はシングルスレッドで動くため「順次コミット」として動作する。
    // ここでは「並列 await しても全件が書き込まれること」を確認する。

    vi.resetModules();
    setupFakeIdb(new FakeDatabase());
    const { saveTemporaryPageDataBatch, getAllTemporaryPageData } =
      await import('../../utils/pdfTemporaryStorage');

    const FILE_A = 'concurrent-a.pdf';
    const FILE_B = 'concurrent-b.pdf';

    // 2 つのファイルに対して異なるページを並列書き込み (PCT-104: pageId 形式)
    const batchA = Array.from({ length: 10 }, (_, i) => ({
      filePath: FILE_A,
      pageId: `src:${i}`,
      data: makePartialPage(i),
    }));
    const batchB = Array.from({ length: 10 }, (_, i) => ({
      filePath: FILE_B,
      pageId: `src:${i}`,
      data: makePartialPage(i),
    }));

    // 並列実行
    await Promise.all([
      saveTemporaryPageDataBatch(batchA),
      saveTemporaryPageDataBatch(batchB),
    ]);

    // 両ファイルのデータが揃っている
    const resultA = await getAllTemporaryPageData(FILE_A);
    const resultB = await getAllTemporaryPageData(FILE_B);

    expect(resultA.size).toBe(10);
    expect(resultB.size).toBe(10);

    // 各ページのデータが正しい (PCT-104: キーは pageId 文字列)
    for (let i = 0; i < 10; i++) {
      expect(resultA.has(`src:${i}`)).toBe(true);
      expect(resultB.has(`src:${i}`)).toBe(true);
    }
  }, 30_000);

  // ── 境界値 3: DB close 後に dbPromise が null にリセットされる ────────
  // 実装 (issue #147): db.onclose は dbPromise.then((cur) => { if (cur === db) dbPromise = null })
  // という Promise チェーンで非同期に null リセットする設計。
  // テスト観点: openDB() が完了した後、db.onclose コールバックが登録されており、
  // 発火すると後続の openDB() 呼び出しで indexedDB.open が再度呼ばれることを確認する。

  it('db.onclose が設定されており、発火後の次アクセスで indexedDB.open が再度呼ばれる', async () => {
    vi.resetModules();
    // 1st DB を準備
    const db1 = new FakeDatabase();
    fakeDb = db1;
    const openCalls: FakeDatabase[] = [];
    let currentFakeDb: FakeDatabase = db1;

    // indexedDB.open を手動で設定 (FakeDatabase を追跡できるように)
    ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = {
      open: vi.fn(() => {
        const db = currentFakeDb;
        openCalls.push(db);
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
    ;(globalThis as unknown as { IDBKeyRange: typeof IDBKeyRange }).IDBKeyRange =
      {
        bound: (lower: string, upper: string) => makeFakeIdbKeyRange(lower, upper),
      } as unknown as typeof IDBKeyRange;

    const { saveTemporaryPageData, getTemporaryPageData } =
      await import('../../utils/pdfTemporaryStorage');

    // 初回接続・書き込み (db1 が使われる) (PCT-104: pageId 形式)
    await saveTemporaryPageData('close-test.pdf', 'src:0', makePartialPage(0));
    expect(openCalls.length).toBe(1);
    expect(openCalls[0]).toBe(db1);

    // db1.onclose を発火 → dbPromise が null にリセットされる
    db1.onclose?.();

    // Promise.then で非同期に null リセットされるのを待つ
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // 2nd DB を用意して差し替え
    const db2 = new FakeDatabase();
    fakeDb = db2;
    currentFakeDb = db2;

    // 次のアクセスで db2 への再接続が起きる (PCT-104: pageId 形式)
    await getTemporaryPageData('close-test.pdf', 'src:0');

    // indexedDB.open が 2 回呼ばれた (= db1 の close 後に db2 への再接続が発生)
    expect(openCalls.length).toBe(2);
    expect(openCalls[1]).toBe(db2);
  }, 30_000);

  // ── 境界値 4: 同一 key の 2 回書き込みは後勝ち ────────────────────────

  it('同一 filePath + 同 pageIndex に 2 回書き込むと後勝ちになる', async () => {
    vi.resetModules();
    setupFakeIdb(new FakeDatabase());
    const { saveTemporaryPageData, getTemporaryPageData } =
      await import('../../utils/pdfTemporaryStorage');

    const FILE = 'overwrite-test.pdf';
    const PAGE_ID = 'src:3'; // PCT-104: pageId 形式

    // 1 回目の書き込み
    const data1: Partial<PageData> = {
      pageIndex: 3,
      isDirty: true,
      textBlocks: [
        { id: 'blk-first', text: 'FIRST_WRITE' } as PageData['textBlocks'][number],
      ],
    };
    await saveTemporaryPageData(FILE, PAGE_ID, data1);

    const afterFirst = await getTemporaryPageData(FILE, PAGE_ID);
    expect(
      (afterFirst?.textBlocks?.[0] as { text?: string } | undefined)?.text,
    ).toBe('FIRST_WRITE');

    // 2 回目の書き込み (後勝ち)
    const data2: Partial<PageData> = {
      pageIndex: 3,
      isDirty: true,
      textBlocks: [
        { id: 'blk-second', text: 'SECOND_WRITE' } as PageData['textBlocks'][number],
      ],
    };
    await saveTemporaryPageData(FILE, PAGE_ID, data2);

    const afterSecond = await getTemporaryPageData(FILE, PAGE_ID);
    // 後勝ち: 2 回目の data2 が読み返せる
    expect(
      (afterSecond?.textBlocks?.[0] as { text?: string } | undefined)?.text,
    ).toBe('SECOND_WRITE');

    // ストアに同一キーの重複エントリは存在しない (1 件のみ)
    const store = fakeDb.stores.get('temporary_changes');
    const matchingKeys = Array.from(store?.keys() ?? []).filter(
      (k) => k === `${FILE}:${PAGE_ID}`,
    );
    expect(matchingKeys.length).toBe(1);
  }, 30_000);

  // ── 境界値 5: thumbnail は保存されない ───────────────────────────────

  it('saveTemporaryPageDataBatch は thumbnail を strip して保存する', async () => {
    vi.resetModules();
    setupFakeIdb(new FakeDatabase());
    const { saveTemporaryPageData, getTemporaryPageData } =
      await import('../../utils/pdfTemporaryStorage');

    const dataWithThumb: Partial<PageData> = {
      pageIndex: 0,
      isDirty: true,
      thumbnail: 'data:image/png;base64,XXXX',
      textBlocks: [],
    };
    // PCT-104: pageId 形式で書き込み
    await saveTemporaryPageData('thumb-strip.pdf', 'src:0', dataWithThumb);

    const stored = fakeDb.stores.get('temporary_changes')?.get(
      'thumb-strip.pdf:src:0',
    ) as Record<string, unknown> | undefined;
    // thumbnail はストアに保存されていない
    expect(stored).not.toHaveProperty('thumbnail');

    // getTemporaryPageData でも thumbnail は無い (PCT-104: pageId 形式)
    const result = await getTemporaryPageData('thumb-strip.pdf', 'src:0');
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>)?.thumbnail).toBeUndefined();
  }, 30_000);

  // ── 境界値 6: 異なる filePath のキーは getAllTemporaryPageData でフィルタされる ─

  it('別 filePath のデータは getAllTemporaryPageData の結果に含まれない', async () => {
    vi.resetModules();
    setupFakeIdb(new FakeDatabase());
    const {
      saveTemporaryPageDataBatch,
      getAllTemporaryPageData,
    } = await import('../../utils/pdfTemporaryStorage');

    // FILE_A と FILE_B の両方に書き込む (PCT-104: pageId 形式)
    await saveTemporaryPageDataBatch([
      { filePath: 'filter-a.pdf', pageId: 'src:0', data: makePartialPage(0) },
      { filePath: 'filter-a.pdf', pageId: 'src:1', data: makePartialPage(1) },
      { filePath: 'filter-b.pdf', pageId: 'src:0', data: makePartialPage(0) },
    ]);

    const resultA = await getAllTemporaryPageData('filter-a.pdf');
    const resultB = await getAllTemporaryPageData('filter-b.pdf');

    // filter-a.pdf は 2 件、filter-b.pdf は 1 件 (PCT-104: キーは pageId 文字列)
    expect(resultA.size).toBe(2);
    expect(resultA.has('src:0')).toBe(true);
    expect(resultA.has('src:1')).toBe(true);

    expect(resultB.size).toBe(1);
    expect(resultB.has('src:0')).toBe(true);
    // filter-b.pdf の結果に filter-a.pdf のデータが混入していない
    expect(resultB.has('src:1')).toBe(false);
  }, 30_000);

  it('deleteTemporaryPageKeys は IDB 失敗を reject する', async () => {
    vi.resetModules();
    setupFakeIdb(new FailingDirtyTransactionDatabase('delete transaction failed'));
    const { deleteTemporaryPageKeys } =
      await import('../../utils/pdfTemporaryStorage');

    // PCT-104 (段階3): pageId 形式 (string[]) で渡す
    await expect(
      deleteTemporaryPageKeys('delete-fail.pdf', ['src:0']),
    ).rejects.toThrow('delete transaction failed');
  });
});
