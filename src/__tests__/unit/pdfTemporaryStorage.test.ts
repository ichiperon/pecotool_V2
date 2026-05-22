import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PageData } from '../../types'

type FakeRequest<T> = IDBRequest<T> & {
  result: T
  error: DOMException | null
  onsuccess: ((this: IDBRequest<T>, ev: Event) => unknown) | null
  onerror: ((this: IDBRequest<T>, ev: Event) => unknown) | null
  onupgradeneeded?: ((this: IDBOpenDBRequest, ev: IDBVersionChangeEvent) => unknown) | null
}

function makeRequest<T>(result: T): FakeRequest<T> {
  return {
    result,
    error: null,
    onsuccess: null,
    onerror: null,
  } as FakeRequest<T>
}

class FakeTransaction {
  oncomplete: ((this: IDBTransaction, ev: Event) => unknown) | null = null
  onerror: ((this: IDBTransaction, ev: Event) => unknown) | null = null
  onabort: ((this: IDBTransaction, ev: Event) => unknown) | null = null
  error: DOMException | null = null
  private completed = false

  constructor(private readonly data: Map<string, unknown>) {}

  objectStore(): IDBObjectStore {
    return new FakeObjectStore(this.data, this) as unknown as IDBObjectStore
  }

  completeSoon(): void {
    if (this.completed) return
    this.completed = true
    queueMicrotask(() => this.oncomplete?.call(this as unknown as IDBTransaction, new Event('complete')))
  }
}

class FakeCursor {
  constructor(
    private readonly entries: Array<[string, unknown]>,
    private index: number,
    private readonly data: Map<string, unknown>,
    private readonly request: FakeRequest<FakeCursor | null>,
    private readonly tx: FakeTransaction,
  ) {}

  get key(): IDBValidKey {
    return this.entries[this.index][0]
  }

  get value(): unknown {
    return this.entries[this.index][1]
  }

  continue(): void {
    this.index++
    queueMicrotask(() => dispatchCursor(this.entries, this.index, this.data, this.request, this.tx))
  }

  delete(): void {
    this.data.delete(String(this.key))
  }
}

class FakeObjectStore {
  constructor(
    private readonly data: Map<string, unknown>,
    private readonly tx: FakeTransaction,
  ) {}

  get(key: IDBValidKey): IDBRequest<unknown> {
    const request = makeRequest<unknown>(undefined)
    queueMicrotask(() => {
      request.result = this.data.get(String(key))
      request.onsuccess?.call(request, new Event('success'))
      this.tx.completeSoon()
    })
    return request
  }

  put(value: unknown, key: IDBValidKey): IDBRequest<IDBValidKey> {
    const request = makeRequest<IDBValidKey>(key)
    this.data.set(String(key), value)
    this.tx.completeSoon()
    return request
  }

  delete(key: IDBValidKey): IDBRequest<undefined> {
    const request = makeRequest<undefined>(undefined)
    this.data.delete(String(key))
    this.tx.completeSoon()
    return request
  }

  openCursor(): IDBRequest<FakeCursor | null> {
    const request = makeRequest<FakeCursor | null>(null)
    const entries = Array.from(this.data.entries())
    queueMicrotask(() => dispatchCursor(entries, 0, this.data, request, this.tx))
    return request as unknown as IDBRequest<FakeCursor | null>
  }
}

class FakeDatabase {
  readonly stores = new Map<string, Map<string, unknown>>()
  readonly objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  } as DOMStringList

  createObjectStore(name: string): IDBObjectStore {
    const store = new Map<string, unknown>()
    this.stores.set(name, store)
    return new FakeObjectStore(store, new FakeTransaction(store)) as unknown as IDBObjectStore
  }

  transaction(name: string): IDBTransaction {
    const store = this.stores.get(name)
    if (!store) throw new Error(`missing store: ${name}`)
    return new FakeTransaction(store) as unknown as IDBTransaction
  }
}

function dispatchCursor(
  entries: Array<[string, unknown]>,
  index: number,
  data: Map<string, unknown>,
  request: FakeRequest<FakeCursor | null>,
  tx: FakeTransaction,
): void {
  request.result = index < entries.length ? new FakeCursor(entries, index, data, request, tx) : null
  request.onsuccess?.call(request, new Event('success'))
  if (!request.result) tx.completeSoon()
}

function makePage(pageIndex: number): PageData {
  return {
    pageIndex,
    width: 100,
    height: 100,
    textBlocks: [],
    isDirty: false,
    thumbnail: 'thumb',
  }
}

describe('pdfTemporaryStorage page cache GC', () => {
  let originalIndexedDB: IDBFactory | undefined
  let fakeDb: FakeDatabase

  beforeEach(() => {
    vi.resetModules()
    originalIndexedDB = globalThis.indexedDB
    fakeDb = new FakeDatabase()
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => ++now)
    ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = {
      open: vi.fn(() => {
        const request = makeRequest(fakeDb) as unknown as IDBOpenDBRequest & FakeRequest<FakeDatabase>
        queueMicrotask(() => {
          request.onupgradeneeded?.call(request, new Event('upgradeneeded') as IDBVersionChangeEvent)
          request.onsuccess?.call(request, new Event('success'))
        })
        return request
      }),
    } as unknown as IDBFactory
  })

  afterEach(() => {
    vi.restoreAllMocks()
    const holder = globalThis as unknown as { indexedDB?: IDBFactory }
    if (originalIndexedDB) {
      holder.indexedDB = originalIndexedDB
    } else {
      delete holder.indexedDB
    }
  })

  it('pages store entries include LRU metadata and omit thumbnails', async () => {
    const { setCachedPage } = await import('../../utils/pdfTemporaryStorage')

    await setCachedPage('doc.pdf:0:1:m1', makePage(0))

    const stored = fakeDb.stores.get('pages')!.get('doc.pdf:0:1:m1') as Record<string, unknown>
    expect(stored.thumbnail).toBeNull()
    expect(stored.__pecotoolCacheUpdatedAt).toEqual(expect.any(Number))
    expect(stored.__pecotoolCacheBytes).toEqual(expect.any(Number))
  })

  it('evicts least recently used pages when the pages store exceeds the entry cap', async () => {
    const { setCachedPage, getCachedPage } = await import('../../utils/pdfTemporaryStorage')

    for (let i = 0; i < 800; i++) {
      await setCachedPage(`doc.pdf:${i}:1:m1`, makePage(i))
    }
    expect(await getCachedPage('doc.pdf:0:1:m1')).toMatchObject({ pageIndex: 0 })
    await setCachedPage('doc.pdf:800:1:m1', makePage(800))

    expect(fakeDb.stores.get('pages')!.size).toBe(800)
    expect(await getCachedPage('doc.pdf:0:1:m1')).toMatchObject({ pageIndex: 0 })
    expect(await getCachedPage('doc.pdf:1:1:m1')).toBeNull()
    expect(await getCachedPage('doc.pdf:800:1:m1')).toMatchObject({ pageIndex: 800, thumbnail: null })
  })
})
