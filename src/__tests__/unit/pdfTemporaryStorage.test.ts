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
  // PCT-117: どのストアに対してどの mode でトランザクションが開かれたかを記録する
  // (readonly/readwrite の分離を検証するため)
  readonly transactionLog: Array<{ store: string; mode: string }> = []

  createObjectStore(name: string): IDBObjectStore {
    const store = new Map<string, unknown>()
    this.stores.set(name, store)
    return new FakeObjectStore(store, new FakeTransaction(store)) as unknown as IDBObjectStore
  }

  transaction(name: string, mode?: IDBTransactionMode): IDBTransaction {
    const store = this.stores.get(name)
    if (!store) throw new Error(`missing store: ${name}`)
    this.transactionLog.push({ store: name, mode: mode ?? 'readonly' })
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
    // IDBKeyRange が jsdom 環境で未定義のため mock を提供する。
    // getAllTemporaryPageData で IDBKeyRange.bound(...) を呼ぶが、FakeObjectStore.openCursor
    // は range を無視して全件返すため、bound の戻り値は何でもよい。
    if (!globalThis.IDBKeyRange) {
      ;(globalThis as unknown as { IDBKeyRange: { bound: (...args: unknown[]) => unknown } }).IDBKeyRange = {
        bound: () => ({}),
      }
    }
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

  // ── PCT-117: getCachedPage の readonly 読み取り / LRU touch 分離 ──────────────

  it('PCT-117: getCachedPage の読み取りは readonly トランザクションを使い、LRU touch は別の readwrite トランザクションで行う', async () => {
    const { setCachedPage, getCachedPage } = await import('../../utils/pdfTemporaryStorage')
    const key = 'mode.pdf:0:1:m1'
    await setCachedPage(key, makePage(0))
    // setCachedPage 分のログをクリアし、getCachedPage 呼び出しのみを計測する
    fakeDb.transactionLog.length = 0

    const result = await getCachedPage(key)
    expect(result).toMatchObject({ pageIndex: 0 })
    // touch は fire-and-forget のため、非同期完了を待つ
    await new Promise((resolve) => setTimeout(resolve, 0))

    const pagesLog = fakeDb.transactionLog.filter((entry) => entry.store === 'pages')
    // 読み取り本体は readwrite ではなく readonly（他の並列読み取りをブロックしない）
    expect(pagesLog[0]).toEqual({ store: 'pages', mode: 'readonly' })
    // LRU タッチ（updatedAt 更新）は読み取りとは別の readwrite トランザクションで行われる
    expect(pagesLog.some((entry) => entry.mode === 'readwrite')).toBe(true)
  })

  it('PCT-117: readonly 読み取り経路でも正しい値が返り、touch分離後も lastAccess (updatedAt) が更新される', async () => {
    const { setCachedPage, getCachedPage } = await import('../../utils/pdfTemporaryStorage')
    const key = 'touch.pdf:0:1:m1'
    await setCachedPage(key, makePage(0))

    const beforeTouch = fakeDb.stores.get('pages')!.get(key) as Record<string, unknown>
    const updatedAtBeforeTouch = beforeTouch.__pecotoolCacheUpdatedAt as number

    const result = await getCachedPage(key)
    expect(result).toMatchObject({ pageIndex: 0 })
    expect(result).not.toHaveProperty('__pecotoolCacheUpdatedAt') // メタデータは剥がされて返る

    // touch (別 readwrite tx) の非同期完了を待つ
    await new Promise((resolve) => setTimeout(resolve, 0))

    const afterTouch = fakeDb.stores.get('pages')!.get(key) as Record<string, unknown>
    expect(afterTouch.__pecotoolCacheUpdatedAt).toBeGreaterThan(updatedAtBeforeTouch)
    // 内容（LRUメタデータ以外）は touch で書き換わらない
    expect(afterTouch.pageIndex).toBe(0)
  })

  it('PCT-117: GET直後にtouch対象がevict済みになっても put で復活させない（幽霊レコード防止）', async () => {
    const { setCachedPage, getCachedPage } = await import('../../utils/pdfTemporaryStorage')
    const key = 'ghost.pdf:0:1:m1'
    await setCachedPage(key, makePage(0))

    const originalUpdatedAt = (fakeDb.stores.get('pages')!.get(key) as Record<string, unknown>)
      .__pecotoolCacheUpdatedAt as number

    // 「GET は成功したが、その後 touch の存在確認時点では既に evict 済み」を再現する。
    // FakeObjectStore.get の 1 回目 (getCachedPage 本体の読み取り) は実データを返し、
    // 2 回目以降 (touch 側の存在確認) は undefined (evict 済み) を返すよう差し替える。
    let callCount = 0
    const originalGet = FakeObjectStore.prototype.get
    const getSpy = vi.spyOn(FakeObjectStore.prototype, 'get').mockImplementation(function (
      this: FakeObjectStore,
      k: IDBValidKey,
    ) {
      callCount++
      if (callCount === 1) {
        return originalGet.call(this, k)
      }
      const request = makeRequest<unknown>(undefined)
      queueMicrotask(() => {
        request.onsuccess?.call(request as unknown as IDBRequest<unknown>, new Event('success'))
      })
      return request as unknown as IDBRequest<unknown>
    })

    try {
      const result = await getCachedPage(key)
      // 読み取り自体はヒット扱いのまま返る（evict はこの後起きた想定のため）
      expect(result).toMatchObject({ pageIndex: 0 })

      // touch の非同期完了を待つ（例外が伝播しないことも併せて確認）
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(callCount).toBeGreaterThanOrEqual(2)
      // touch が「存在しない」と判定した場合に put しなかったことを検証:
      // updatedAt が touch 前の値のまま変化していない（= 幽霊レコードとして復活していない）
      const afterTouch = fakeDb.stores.get('pages')!.get(key) as Record<string, unknown>
      expect(afterTouch.__pecotoolCacheUpdatedAt).toBe(originalUpdatedAt)
    } finally {
      getSpy.mockRestore()
    }
  })

  // ── PCT-070 / PCT-104: 保存完了後のページ限定クリア ─────────────────────────

  it('PCT-070 / PCT-104: clearTemporaryChangesForPages は指定 pageId のキーのみ削除する', async () => {
    const { saveTemporaryPageDataBatch, clearTemporaryChangesForPages } =
      await import('../../utils/pdfTemporaryStorage')

    // PCT-104 (A-lite 段階2): pageId = "src:N" を使って保存
    await saveTemporaryPageDataBatch([
      { filePath: 'a.pdf', pageId: 'src:0', data: makePage(0) },
      { filePath: 'a.pdf', pageId: 'src:1', data: makePage(1) },
      { filePath: 'a.pdf', pageId: 'src:2', data: makePage(2) },
      { filePath: 'b.pdf', pageId: 'src:0', data: makePage(0) },
    ])

    // pageId 文字列配列でクリア
    await clearTemporaryChangesForPages('a.pdf', ['src:0', 'src:2'])

    const dirtyStore = fakeDb.stores.get('temporary_changes')!
    // 保存で回収した a.pdf の src:0, src:2 だけが消え、未回収の src:1 と別ファイルは残る
    expect(dirtyStore.has('a.pdf:src:0')).toBe(false)
    expect(dirtyStore.has('a.pdf:src:2')).toBe(false)
    expect(dirtyStore.has('a.pdf:src:1')).toBe(true)
    expect(dirtyStore.has('b.pdf:src:0')).toBe(true)
  })

  // ── PCT-071: saveTemporaryPageDataBatch のタイマー残留解消 ──────────

  it('PCT-071: saveTemporaryPageDataBatch 完了後にタイムアウトタイマーが残留しない', async () => {
    const { saveTemporaryPageDataBatch } = await import('../../utils/pdfTemporaryStorage')

    vi.useFakeTimers()
    try {
      await saveTemporaryPageDataBatch([
        { filePath: 'a.pdf', pageId: 'src:0', data: makePage(0) },
      ])
      // waitForTransaction が clearTimeout 済みのため、タイマーは残らない
      // (旧実装は自前 setTimeout を clear せず 10 秒間残留していた)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  // ── PCT-104: 旧キー (filePath:N) データの移行フォールバック ──────────

  it('PCT-104: getTemporaryPageData は旧キー (filePath:N) で保存されたデータを pageId で読める', async () => {
    const { getTemporaryPageData, saveTemporaryPageDataBatch } = await import('../../utils/pdfTemporaryStorage')

    // IDB ストアを初期化するため先に何か書き込む（openDB + upgrade が走る）
    await saveTemporaryPageDataBatch([{ filePath: 'doc.pdf', pageId: 'src:99', data: makePage(99) }])

    // 旧キー形式 (filePath:N) でデータを直接 IDB に書き込む（アプリ更新前の状態を再現）
    const dirtyStore = fakeDb.stores.get('temporary_changes')!
    const oldData = { ...makePage(3), isDirty: true }
    dirtyStore.set('doc.pdf:3', oldData)

    // 新キー形式 pageId = "src:3" でアクセスすると旧キーにフォールバックして読める
    const result = await getTemporaryPageData('doc.pdf', 'src:3')
    expect(result).not.toBeNull()
    expect(result?.isDirty).toBe(true)
    expect(result?.pageIndex).toBe(3)
  })

  it('PCT-104: getAllTemporaryPageData は旧キーエントリを pageId (src:N) にマップして返す', async () => {
    const { getAllTemporaryPageData, saveTemporaryPageDataBatch } =
      await import('../../utils/pdfTemporaryStorage')

    // 新キー形式でまず 1 件書き込み（IDB ストアを初期化）
    await saveTemporaryPageDataBatch([
      { filePath: 'doc.pdf', pageId: 'src:1', data: { ...makePage(1), isDirty: true } },
    ])

    // 旧キー形式と新キー形式が混在する状態（アプリ更新直後）
    const dirtyStore = fakeDb.stores.get('temporary_changes')!
    const oldData = { ...makePage(0), isDirty: true }
    dirtyStore.set('doc.pdf:0', oldData) // 旧キー

    const result = await getAllTemporaryPageData('doc.pdf')
    // 旧キー (doc.pdf:0) は pageId "src:0" にマップされる
    expect(result.has('src:0')).toBe(true)
    // 新キー (doc.pdf:src:1) は pageId "src:1" にマップされる
    expect(result.has('src:1')).toBe(true)
    expect(result.size).toBe(2)
  })

  // ── PCT-104 (B1 回帰テスト): remapTemporaryPageEntries ──────────────────

  it('PCT-104 B1: remapTemporaryPageEntries — move後のLRU退避ページが新キーに移動する', async () => {
    // シナリオ: 3ページPDF、move(0→1)後に pageOrder=[1,0,2]。
    //   source index 0 のページ (src:0) は LRU 退避済み（IDB に 'src:0' キーで書き込み済み、
    //   clean、保存対象外）。
    //   保存完了後の normalizePageOrderAfterSave([1,0,2]) → [0,1,2]。
    //   remap(oldPageOrder=[1,0,2], normalizedPageOrder=[0,1,2], dirtyPageIds=[])
    //
    //   src:0 のマッピング: oldPageOrder=[1,0,2] で src:0 は displayIdx=1
    //   → normalizedPageOrder=[0,1,2] の displayIdx=1 → 新 pageId = src:1
    //   → キー移動: put(remap.pdf:src:1, src0_data), delete(remap.pdf:src:0)
    //
    // 期待:
    //   - 'src:0'（LRU退避クリーンページ）は 'src:1' に移動 → src:0 消滅
    //   - 'src:1' に移動後の内容に src:0 のデータが入る
    //   - 'src:2'（LRU退避ページ）: displayIdx=2→2 で同一キー → スキップ（そのまま存在）
    const { remapTemporaryPageEntries, saveTemporaryPageDataBatch, getAllTemporaryPageData } =
      await import('../../utils/pdfTemporaryStorage')

    // LRU退避ページをIDBに書き込む（非dirty = IDB キャッシュのみ）
    await saveTemporaryPageDataBatch([
      {
        filePath: 'remap.pdf',
        pageId: 'src:0',  // LRU退避ページ（move で display 0 から display 1 へ）
        data: { ...makePage(0), isDirty: false, textBlocks: [{ id: 'b0', text: 'LRU_PAGE0', originalText: '', bbox: { x: 0, y: 0, width: 50, height: 20 }, writingMode: 'horizontal', order: 0, isNew: false, isDirty: false }] },
      },
      {
        filePath: 'remap.pdf',
        pageId: 'src:2',  // LRU退避ページ（不動点）
        data: { ...makePage(2), isDirty: false, textBlocks: [{ id: 'b2', text: 'LRU_PAGE2', originalText: '', bbox: { x: 0, y: 0, width: 50, height: 20 }, writingMode: 'horizontal', order: 0, isNew: false, isDirty: false }] },
      },
    ])

    const oldPageOrder = [1, 0, 2]  // move後
    const normalizedPageOrder = [0, 1, 2]  // normalize後
    // dirty エントリなし（src:1 はメモリにあり保存されたが、IDB に LRU エントリは存在しない）
    const dirtyPageIds: string[] = []

    await remapTemporaryPageEntries('remap.pdf', oldPageOrder, normalizedPageOrder, dirtyPageIds)

    const afterRemap = await getAllTemporaryPageData('remap.pdf')
    // src:0（LRU退避クリーン）は src:1 へキー移動 → src:0 消滅
    expect(afterRemap.has('src:0')).toBe(false)
    // src:1 に移動後の内容は LRU_PAGE0 のデータ
    expect(afterRemap.has('src:1')).toBe(true)
    const movedData = afterRemap.get('src:1') as { textBlocks: Array<{ text: string }> }
    expect(movedData.textBlocks[0].text).toBe('LRU_PAGE0')
    // src:2（不動点）はそのまま存在する
    expect(afterRemap.has('src:2')).toBe(true)
    const lruData = afterRemap.get('src:2') as { textBlocks: Array<{ text: string }> }
    expect(lruData.textBlocks[0].text).toBe('LRU_PAGE2')
  })

  it('PCT-104 B1: remapTemporaryPageEntries — IDB が空でも例外なく完了する', async () => {
    const { remapTemporaryPageEntries } = await import('../../utils/pdfTemporaryStorage')

    // エントリが存在しない状態での remap は no-op として完了する
    await expect(
      remapTemporaryPageEntries('empty.pdf', [0, 1], [0, 1], [])
    ).resolves.toBeUndefined()
  })

  it('PCT-104 B1 ミューテーション実証: remap なし → 旧キーのまま残りキーズレが生じる', async () => {
    // remap を実行しない場合は旧キーが残る（ミューテーション実証）
    // → 次回 getAllTemporaryPageData で取得するとキーズレが発生し
    //   replaceText scope='all' でこのページを取得できない
    const { saveTemporaryPageDataBatch, getAllTemporaryPageData } =
      await import('../../utils/pdfTemporaryStorage')

    // move(0→1)後: displayIndex=0 の pageId='src:1' で LRU 退避
    await saveTemporaryPageDataBatch([
      { filePath: 'noremap.pdf', pageId: 'src:1', data: { ...makePage(1), isDirty: false } },
    ])

    // remap しない (no-op)
    const result = await getAllTemporaryPageData('noremap.pdf')
    // 旧キー 'src:1' がそのまま残る
    expect(result.has('src:1')).toBe(true)
    // 正規化後に 'src:0' を期待しても存在しない
    expect(result.has('src:0')).toBe(false)
  })

  // ── PCT-104 R2: real-remap 統合テスト（remap を mock しない）──────────────
  //
  // ミューテーション B 検収基準:
  //   remapTemporaryPageEntries の put/delete ロジックを削除すると、
  //   キー移動が起きず src:0 が残り src:1 が出現しないため、このテストが fail する。
  //   テストを復元（リバート）すれば再び green になることで不動点性を実証する。

  it('PCT-104 R2: real-remap — LRU退避キー移動後に normalize 済み pageId でデータが取得できる', async () => {
    // シナリオ:
    //   3ページPDF。ユーザーが move(0→1) を実行 → pageOrder=[1,0,2]。
    //   source index 0 のページ (src:0) が LRU 退避されて IDB に存在する（clean）。
    //
    //   保存完了後:
    //     remap(oldPageOrder=[1,0,2], normalizedPageOrder=[0,1,2], dirtyPageIds=[])
    //     src:0 → displayIdx=1(oldPageOrder) → newPageId=src:1 → キー移動
    //
    //   正規化後のアプリコードは src:1 でこのページを探す。
    //   remap 後は src:1 に存在するため replaceText scope='all' 等でヒットする（ヒット数=1）。
    //   remap なし（ミューテーション B）だと src:0 のままで src:1 を探してヒット数=0。
    const { remapTemporaryPageEntries, saveTemporaryPageDataBatch, getAllTemporaryPageData } =
      await import('../../utils/pdfTemporaryStorage')

    const lruText = 'SCOPE_ALL_SHOULD_HIT'

    // LRU 退避: source index 0 のページが src:0 キーで IDB に書かれている
    await saveTemporaryPageDataBatch([
      {
        filePath: 'realremap.pdf',
        pageId: 'src:0',
        data: {
          ...makePage(0),
          isDirty: false,
          textBlocks: [{ id: 'r0', text: lruText, originalText: '', bbox: { x: 0, y: 0, width: 50, height: 20 }, writingMode: 'horizontal', order: 0, isNew: false, isDirty: false }],
        },
      },
    ])

    // move(0→1) 後の remap を実行（real 実装を呼ぶ）
    await remapTemporaryPageEntries(
      'realremap.pdf',
      [1, 0, 2],   // oldPageOrder (move後)
      [0, 1, 2],   // normalizedPageOrder
      [],          // dirtyPageIds (なし)
    )

    // 正規化後のアプリコードは src:1 でページを取得する
    const afterRemap = await getAllTemporaryPageData('realremap.pdf')

    // remap 後: src:1 にデータが移動している（ヒット数=1 を確認）
    const hitCount = afterRemap.has('src:1') ? 1 : 0
    expect(hitCount).toBe(1)
    const hitData = afterRemap.get('src:1') as { textBlocks: Array<{ text: string }> }
    expect(hitData.textBlocks[0].text).toBe(lruText)

    // remap 後: src:0 は消滅している（キー移動完了）
    expect(afterRemap.has('src:0')).toBe(false)
  })
})
