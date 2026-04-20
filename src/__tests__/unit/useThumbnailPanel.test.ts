/**
 * useThumbnailPanel の主要ロジックパターンをユニットテストする。
 *
 * React hook を直接レンダリングせず、hook 内部で使われている
 * ステートマシンのパターン（遅延ロード、キュー管理、購読、epoch 無効化）を
 * 同等のロジックで検証する。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// pdfjs-dist は jsdom 環境で DOMMatrix 等を要求しロード時に失敗する。
// useThumbnailPanel は pdfjs を直接呼ばないため、依存解決のみで足りる。
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({ promise: Promise.resolve({ numPages: 0, destroy: vi.fn() }) })),
}))

// ---------------------------------------------------------------------------
// 1. triggerThumbnailLoad の冪等性（deferred load pattern）
// ---------------------------------------------------------------------------
describe('triggerThumbnailLoad idempotency', () => {
  let deferredLoadRef: { current: (() => void) | null }

  function triggerThumbnailLoad() {
    const fn = deferredLoadRef.current
    if (fn) {
      deferredLoadRef.current = null
      fn()
    }
  }

  beforeEach(() => {
    deferredLoadRef = { current: null }
  })

  it('calls the deferred function exactly once', () => {
    const fn = vi.fn()
    deferredLoadRef.current = fn

    triggerThumbnailLoad()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('second call is a no-op (idempotent)', () => {
    const fn = vi.fn()
    deferredLoadRef.current = fn

    triggerThumbnailLoad()
    triggerThumbnailLoad()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does nothing when no deferred function is set', () => {
    // Should not throw
    expect(() => triggerThumbnailLoad()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 2. キュー管理: PDF 準備前にキューに追加 → 準備後に処理
// ---------------------------------------------------------------------------
describe('queue management', () => {
  let isPdfReadyRef: { current: boolean }
  let isProcessingRef: { current: boolean }
  let queueRef: { current: number[] }
  let epochRef: { current: number }
  let processedItems: number[]

  /** hook 内の processThumbnailQueue と同等のロジック（Worker 呼び出しを省略） */
  async function processThumbnailQueue(epoch: number) {
    if (!isPdfReadyRef.current) return
    if (isProcessingRef.current) return
    isProcessingRef.current = true
    try {
      while (queueRef.current.length > 0) {
        if (epochRef.current !== epoch) break
        const item = queueRef.current.shift()!
        processedItems.push(item)
      }
    } finally {
      isProcessingRef.current = false
    }
  }

  /** hook 内の requestThumbnail と同等 */
  function requestThumbnail(pageIndex: number) {
    if (!queueRef.current.includes(pageIndex)) {
      queueRef.current.push(pageIndex)
    }
  }

  beforeEach(() => {
    isPdfReadyRef = { current: false }
    isProcessingRef = { current: false }
    queueRef = { current: [] }
    epochRef = { current: 1 }
    processedItems = []
  })

  it('does not process queue when PDF is not ready', async () => {
    requestThumbnail(0)
    requestThumbnail(1)
    await processThumbnailQueue(1)
    expect(processedItems).toEqual([])
    expect(queueRef.current).toEqual([0, 1])
  })

  it('processes queued items after PDF becomes ready', async () => {
    requestThumbnail(0)
    requestThumbnail(1)
    requestThumbnail(2)

    // PDF not ready yet — queue is held
    await processThumbnailQueue(1)
    expect(processedItems).toEqual([])

    // PDF becomes ready
    isPdfReadyRef.current = true
    await processThumbnailQueue(1)
    expect(processedItems).toEqual([0, 1, 2])
    expect(queueRef.current).toEqual([])
  })

  it('prevents duplicate queue entries', () => {
    requestThumbnail(5)
    requestThumbnail(5)
    requestThumbnail(5)
    expect(queueRef.current).toEqual([5])
  })

  it('does not reprocess when already processing (guard)', async () => {
    isPdfReadyRef.current = true
    isProcessingRef.current = true
    requestThumbnail(0)
    await processThumbnailQueue(1)
    // Items remain in queue because guard prevented processing
    expect(processedItems).toEqual([])
    expect(queueRef.current).toEqual([0])
  })
})

// ---------------------------------------------------------------------------
// 3. subscribeThumbnail の購読パターン
// ---------------------------------------------------------------------------
describe('subscribeThumbnail pattern', () => {
  let itemListenersRef: { current: Map<number, Set<() => void>> }

  function subscribeThumbnail(index: number, cb: () => void) {
    if (!itemListenersRef.current.has(index)) {
      itemListenersRef.current.set(index, new Set())
    }
    itemListenersRef.current.get(index)!.add(cb)
    return () => {
      itemListenersRef.current.get(index)?.delete(cb)
    }
  }

  beforeEach(() => {
    itemListenersRef = { current: new Map() }
  })

  it('returns an unsubscribe function', () => {
    const cb = vi.fn()
    const unsub = subscribeThumbnail(0, cb)
    expect(typeof unsub).toBe('function')
  })

  it('adds callback to listeners set', () => {
    const cb = vi.fn()
    subscribeThumbnail(3, cb)
    expect(itemListenersRef.current.get(3)?.has(cb)).toBe(true)
  })

  it('removes callback on unsubscribe', () => {
    const cb = vi.fn()
    const unsub = subscribeThumbnail(3, cb)
    unsub()
    expect(itemListenersRef.current.get(3)?.has(cb)).toBe(false)
  })

  it('supports multiple subscribers for the same index', () => {
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    subscribeThumbnail(0, cb1)
    subscribeThumbnail(0, cb2)
    expect(itemListenersRef.current.get(0)?.size).toBe(2)
  })

  it('unsubscribing one does not affect others', () => {
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    const unsub1 = subscribeThumbnail(0, cb1)
    subscribeThumbnail(0, cb2)

    unsub1()
    expect(itemListenersRef.current.get(0)?.has(cb1)).toBe(false)
    expect(itemListenersRef.current.get(0)?.has(cb2)).toBe(true)
  })

  it('notifies only the correct index listeners', () => {
    const cb0 = vi.fn()
    const cb1 = vi.fn()
    subscribeThumbnail(0, cb0)
    subscribeThumbnail(1, cb1)

    // Simulate notification for index 0 only
    itemListenersRef.current.get(0)?.forEach(cb => cb())
    expect(cb0).toHaveBeenCalledTimes(1)
    expect(cb1).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 4. epoch ベースの無効化（ファイル切り替え時）
// ---------------------------------------------------------------------------
describe('epoch-based invalidation', () => {
  let epochRef: { current: number }
  let isPdfReadyRef: { current: boolean }
  let isProcessingRef: { current: boolean }
  let queueRef: { current: number[] }
  let thumbnailsRef: { current: Map<number, string> }
  let itemListenersRef: { current: Map<number, Set<() => void>> }
  let deferredLoadRef: { current: (() => void) | null }

  /** Simulate the file-switch cleanup from the useEffect */
  function simulateFileSwitch() {
    epochRef.current++
    queueRef.current = []
    isProcessingRef.current = false
    isPdfReadyRef.current = false
    deferredLoadRef.current = null

    // Clear thumbnails
    thumbnailsRef.current = new Map()

    // Notify all listeners (switch to placeholder)
    itemListenersRef.current.forEach(cbs => cbs.forEach(cb => cb()))
  }

  /** Simplified processThumbnailQueue */
  async function processThumbnailQueue(epoch: number) {
    if (!isPdfReadyRef.current) return
    if (isProcessingRef.current) return
    isProcessingRef.current = true
    const processed: number[] = []
    try {
      while (queueRef.current.length > 0) {
        if (epochRef.current !== epoch) break
        processed.push(queueRef.current.shift()!)
      }
    } finally {
      isProcessingRef.current = false
    }
    return processed
  }

  beforeEach(() => {
    epochRef = { current: 0 }
    isPdfReadyRef = { current: false }
    isProcessingRef = { current: false }
    queueRef = { current: [] }
    thumbnailsRef = { current: new Map() }
    itemListenersRef = { current: new Map() }
    deferredLoadRef = { current: null }
  })

  it('increments epoch on file switch', () => {
    expect(epochRef.current).toBe(0)
    simulateFileSwitch()
    expect(epochRef.current).toBe(1)
    simulateFileSwitch()
    expect(epochRef.current).toBe(2)
  })

  it('clears queue on file switch', () => {
    queueRef.current = [0, 1, 2, 3]
    simulateFileSwitch()
    expect(queueRef.current).toEqual([])
  })

  it('resets isPdfReady on file switch', () => {
    isPdfReadyRef.current = true
    simulateFileSwitch()
    expect(isPdfReadyRef.current).toBe(false)
  })

  it('clears thumbnails on file switch', () => {
    thumbnailsRef.current.set(0, 'blob:old-0')
    thumbnailsRef.current.set(1, 'blob:old-1')
    simulateFileSwitch()
    expect(thumbnailsRef.current.size).toBe(0)
  })

  it('notifies all listeners on file switch', () => {
    const cb0 = vi.fn()
    const cb1 = vi.fn()
    itemListenersRef.current.set(0, new Set([cb0]))
    itemListenersRef.current.set(1, new Set([cb1]))

    simulateFileSwitch()
    expect(cb0).toHaveBeenCalledTimes(1)
    expect(cb1).toHaveBeenCalledTimes(1)
  })

  it('stale epoch stops queue processing mid-flight', async () => {
    isPdfReadyRef.current = true
    queueRef.current = [0, 1, 2]
    const epoch = epochRef.current

    // Start processing at current epoch, but bump epoch mid-flight
    epochRef.current = epoch + 1

    const processed = await processThumbnailQueue(epoch)
    // Should have bailed immediately due to epoch mismatch
    expect(processed).toEqual([])
    // Items remain in queue
    expect(queueRef.current).toEqual([0, 1, 2])
  })
})

// ---------------------------------------------------------------------------
// 5. flushBatch ロジック: 重複URLの解放とリスナー通知
// ---------------------------------------------------------------------------
describe('flushBatch logic', () => {
  let thumbnailsRef: { current: Map<number, string> }
  let itemListenersRef: { current: Map<number, Set<() => void>> }
  let pendingBatchRef: { current: Array<[number, string]> }
  let revokedUrls: string[]

  function flushBatch() {
    const entries = pendingBatchRef.current.splice(0)
    if (entries.length === 0) return
    for (const [idx, url] of entries) {
      if (thumbnailsRef.current.has(idx)) {
        // Duplicate — revoke the new URL
        revokedUrls.push(url)
      } else {
        thumbnailsRef.current.set(idx, url)
        itemListenersRef.current.get(idx)?.forEach(cb => cb())
      }
    }
  }

  beforeEach(() => {
    thumbnailsRef = { current: new Map() }
    itemListenersRef = { current: new Map() }
    pendingBatchRef = { current: [] }
    revokedUrls = []
  })

  it('stores thumbnail and notifies listener', () => {
    const cb = vi.fn()
    itemListenersRef.current.set(0, new Set([cb]))
    pendingBatchRef.current.push([0, 'blob:thumb-0'])

    flushBatch()
    expect(thumbnailsRef.current.get(0)).toBe('blob:thumb-0')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('revokes duplicate URL instead of overwriting', () => {
    thumbnailsRef.current.set(0, 'blob:existing')
    pendingBatchRef.current.push([0, 'blob:duplicate'])

    flushBatch()
    expect(thumbnailsRef.current.get(0)).toBe('blob:existing')
    expect(revokedUrls).toEqual(['blob:duplicate'])
  })

  it('does nothing when batch is empty', () => {
    const cb = vi.fn()
    itemListenersRef.current.set(0, new Set([cb]))

    flushBatch()
    expect(cb).not.toHaveBeenCalled()
    expect(thumbnailsRef.current.size).toBe(0)
  })

  it('handles multiple items in a single batch', () => {
    const cb0 = vi.fn()
    const cb1 = vi.fn()
    itemListenersRef.current.set(0, new Set([cb0]))
    itemListenersRef.current.set(1, new Set([cb1]))

    pendingBatchRef.current.push([0, 'blob:0'], [1, 'blob:1'])
    flushBatch()

    expect(thumbnailsRef.current.size).toBe(2)
    expect(cb0).toHaveBeenCalledTimes(1)
    expect(cb1).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// S-07: 実 hook でファイル切替時の世代管理（epoch / URL revoke / unmount cleanup）
// ---------------------------------------------------------------------------
describe('S-07: useThumbnailPanel epoch & URL lifecycle (real hook)', () => {
  // テスト中に生成された Worker を全て参照できるようにする
  const createdWorkers: Array<MockThumbnailWorker> = []
  // URL.createObjectURL の連番カウンタ
  let urlCounter = 0
  // 生成された Blob URL を全て記録（revoke の照合用）
  let createdUrls: string[] = []
  let revokedUrls: string[] = []

  /**
   * thumbnail.worker.ts と同等の最小モック。
   * - LOAD_PDF を受け取ったら LOAD_COMPLETE を返す。
   * - GENERATE_THUMBNAIL を受け取ったら THUMBNAIL_DONE を返すが、
   *   テストから明示的に `respond()` を呼ぶまで送信を保留できる。
   */
  class MockThumbnailWorker {
    onmessage: ((e: MessageEvent<any>) => void) | null = null
    onerror: ((e: any) => void) | null = null
    onmessageerror: ((e: any) => void) | null = null
    listeners: Array<{ type: string; cb: any }> = []
    /** GENERATE_THUMBNAIL 受信時に保留した解決関数 */
    pendingGenerates: Array<{ pageIndex: number; resolve: () => void }> = []
    terminated = false

    constructor() {
      createdWorkers.push(this)
    }

    postMessage(req: any, _transfer?: any) {
      if (req?.type === 'LOAD_PDF') {
        // 即座に LOAD_COMPLETE を返す
        queueMicrotask(() => {
          this.deliver({ type: 'LOAD_COMPLETE', numPages: 10 })
        })
        return
      }
      if (req?.type === 'GENERATE_THUMBNAIL') {
        const pageIndex = req.pageIndex
        // テスト側で明示的に呼ばれるまで保留する
        this.pendingGenerates.push({
          pageIndex,
          resolve: () => {
            this.deliver({
              type: 'THUMBNAIL_DONE',
              pageIndex,
              bytes: new Uint8Array([1, 2, 3]),
            })
          },
        })
        return
      }
    }

    /** 全ての保留中 GENERATE_THUMBNAIL を THUMBNAIL_DONE で応答する */
    flushAllThumbnails() {
      const pending = this.pendingGenerates.splice(0)
      for (const p of pending) p.resolve()
    }

    private deliver(msg: any) {
      const ev = { data: msg } as MessageEvent<any>
      if (this.onmessage) this.onmessage(ev)
      this.listeners.forEach(l => {
        if (l.type === 'message') l.cb(ev)
      })
    }

    addEventListener(type: string, cb: any) {
      this.listeners.push({ type, cb })
    }
    removeEventListener(_type: string, cb: any) {
      this.listeners = this.listeners.filter(l => l.cb !== cb)
    }
    terminate() {
      this.terminated = true
    }
  }

  let originalWorker: any
  let originalCreate: any
  let originalRevoke: any
  let originalFetch: any
  let originalRequestIdleCallback: any

  beforeEach(async () => {
    createdWorkers.length = 0
    urlCounter = 0
    createdUrls = []
    revokedUrls = []

    // Worker をモックで差し替え
    originalWorker = (globalThis as any).Worker
    ;(globalThis as any).Worker = MockThumbnailWorker

    // LOAD_PDF は requestIdleCallback 経由で遅延されるため、
    // テストでは即時実行するモックを差し込む。
    originalRequestIdleCallback = (globalThis as any).requestIdleCallback
    ;(globalThis as any).requestIdleCallback = (cb: () => void) => {
      queueMicrotask(() => cb())
      return 0 as any
    }

    // URL.createObjectURL / revokeObjectURL を spy
    originalCreate = (URL as any).createObjectURL
    originalRevoke = (URL as any).revokeObjectURL
    ;(URL as any).createObjectURL = vi.fn((blob: Blob) => {
      const u = `blob:mock-${++urlCounter}`
      // サムネイル由来の URL のみ追跡（pdfLoader の workerSrc 用 URL は除外）
      if (blob && (blob as any).type === 'image/jpeg') {
        createdUrls.push(u)
      }
      return u
    })
    ;(URL as any).revokeObjectURL = vi.fn((u: string) => {
      revokedUrls.push(u)
    })

    // fetch をモック（hook がメインスレッドで PDF を取得する）
    originalFetch = (globalThis as any).fetch
    ;(globalThis as any).fetch = vi.fn(async (_url: string) => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    }))

    // pecoStore を初期化（前テストの状態を引きずらない）
    const { usePecoStore } = await import('../../store/pecoStore')
    usePecoStore.setState({ document: null, currentPageIndex: 0 })
  })

  afterEach(() => {
    ;(globalThis as any).Worker = originalWorker
    ;(URL as any).createObjectURL = originalCreate
    ;(URL as any).revokeObjectURL = originalRevoke
    ;(globalThis as any).fetch = originalFetch
    if (originalRequestIdleCallback === undefined) {
      delete (globalThis as any).requestIdleCallback
    } else {
      ;(globalThis as any).requestIdleCallback = originalRequestIdleCallback
    }
  })

  /** ストアにダミードキュメントを設定する */
  async function setDoc(filePath: string, totalPages = 5) {
    const { usePecoStore } = await import('../../store/pecoStore')
    usePecoStore.setState({
      document: {
        filePath,
        fileName: filePath,
        totalPages,
        metadata: { title: undefined, author: undefined },
        pages: new Map(),
      } as any,
    })
  }

  /** マイクロタスク + マクロタスクを掃く */
  async function flush() {
    // microtasks
    await Promise.resolve()
    await Promise.resolve()
    // batch flush timer (50ms)
    await new Promise(r => setTimeout(r, 60))
    await Promise.resolve()
  }

  it('S-07-01: stale epoch URL is revoked and not stored on file switch mid-flight', async () => {
    const { useThumbnailPanel } = await import('../../hooks/useThumbnailPanel')
    await setDoc('/path/A.pdf', 5)

    const { result, unmount } = renderHook(() => useThumbnailPanel())

    // Worker 初期化と LOAD_COMPLETE を待つ
    await flush()
    expect(createdWorkers.length).toBeGreaterThan(0)

    // ページ 0 をリクエスト → Worker が GENERATE を保留
    act(() => {
      result.current.requestThumbnail(0)
    })
    await flush()

    const w0 = createdWorkers[0]
    expect(w0.pendingGenerates.length).toBe(1)

    // Worker から THUMBNAIL_DONE を返す → pendingBatchRef に積まれる
    act(() => {
      w0.flushAllThumbnails()
    })
    // microtask だけ進めて batch timer は未発火の状態にする
    await Promise.resolve()
    await Promise.resolve()

    // この時点で createObjectURL は呼ばれているはず
    expect(createdUrls.length).toBe(1)
    const staleUrl = createdUrls[0]

    // バッチ flush 前にファイル切替（epoch++）
    await setDoc('/path/B.pdf', 5)
    await Promise.resolve()
    await Promise.resolve()
    // batch timer 発火を待つ
    await new Promise(r => setTimeout(r, 60))

    // 旧 epoch の URL は revoke され、thumbnailsRef には残っていない
    expect(revokedUrls).toContain(staleUrl)
    expect(result.current.getThumbnail(0)).toBeUndefined()

    unmount()
  })

  it('S-07-02: unmount revokes all retained thumbnail URLs', async () => {
    const { useThumbnailPanel } = await import('../../hooks/useThumbnailPanel')
    await setDoc('/path/A.pdf', 5)

    const { result, unmount } = renderHook(() => useThumbnailPanel())
    await flush()

    // 3 ページ分 retain
    act(() => {
      result.current.requestThumbnail(0)
      result.current.requestThumbnail(1)
      result.current.requestThumbnail(2)
    })
    await flush()
    const w0 = createdWorkers[0]
    act(() => {
      w0.flushAllThumbnails()
    })
    await flush()

    // thumbnailsRef に 3 件入っているはず
    expect(result.current.getThumbnail(0)).toBeDefined()
    expect(result.current.getThumbnail(1)).toBeDefined()
    expect(result.current.getThumbnail(2)).toBeDefined()

    const retainedUrls = [
      result.current.getThumbnail(0)!,
      result.current.getThumbnail(1)!,
      result.current.getThumbnail(2)!,
    ]

    revokedUrls = []
    unmount()

    // unmount cleanup で全ての URL が revoke されている
    for (const u of retainedUrls) {
      expect(revokedUrls).toContain(u)
    }
  })

  it('S-07-03: rapid file switch A→B→A does not leak B thumbnails into A view', async () => {
    const { useThumbnailPanel } = await import('../../hooks/useThumbnailPanel')
    await setDoc('/path/A.pdf', 5)

    const { result, unmount } = renderHook(() => useThumbnailPanel())
    await flush()

    // A: ページ 0 をリクエスト
    act(() => {
      result.current.requestThumbnail(0)
    })
    await flush()

    // B に切替（A の pending は破棄される）
    await setDoc('/path/B.pdf', 5)
    await flush()

    const wB = createdWorkers[createdWorkers.length - 1]
    // B でページ 0 をリクエストして即応答
    act(() => {
      result.current.requestThumbnail(0)
    })
    await flush()
    act(() => {
      wB.flushAllThumbnails()
    })
    await flush()

    const bThumb = result.current.getThumbnail(0)
    expect(bThumb).toBeDefined()

    // A に戻す → thumbnailsRef はクリアされ、B のサムネイルは消える
    await setDoc('/path/A.pdf', 5)
    await flush()

    expect(result.current.getThumbnail(0)).toBeUndefined()
    // B のサムネイル URL は revoke されている
    expect(revokedUrls).toContain(bThumb!)

    unmount()
  })
})
