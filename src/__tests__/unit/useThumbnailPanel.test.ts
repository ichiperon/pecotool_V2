/**
 * useThumbnailPanel の主要ロジックパターンをユニットテストする。
 *
 * React hook を直接レンダリングせず、hook 内部で使われている
 * ステートマシンのパターン（遅延ロード、キュー管理、購読、epoch 無効化）を
 * 同等のロジックで検証する。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

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
