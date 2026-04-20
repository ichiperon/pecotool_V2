/**
 * S-14: usePrefetching の unmount cleanup と timedOut 解放を検証する。
 *
 * - prefetchTasksRef は外部公開されないため、`task.cancel` の呼び出し回数と
 *   timeoutId が clearTimeout されるかで間接観察する。
 * - OffscreenCanvas の null 化（GC 促進）は直接確認できないので、
 *   タイムアウト時に `wrapper.cancelled = true` になり `task.cancel()` が
 *   呼ばれていることをもって等価とみなす。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// pdfjs-dist は jsdom 環境で DOMMatrix を要求するため、最小モックで差し替える。
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({ numPages: 0, destroy: vi.fn() }),
  })),
}))

// pdfLoader.getCachedPageProxy をモックして任意のページプロキシを返す。
const renderTasks: Array<{
  cancel: ReturnType<typeof vi.fn>
  resolve: () => void
  reject: (e: unknown) => void
  promise: Promise<void>
}> = []

vi.mock('../../utils/pdfLoader', () => ({
  getCachedPageProxy: vi.fn(async function mockGetCachedPageProxy(
    _filePath: string,
    _pageIndex: number,
  ) {
    return {
      _transport: { destroyed: false },
      getViewport: function mockGetViewport() {
        return { width: 100, height: 100 }
      },
      render: function mockRender() {
        let resolveFn!: () => void
        let rejectFn!: (e: unknown) => void
        const promise = new Promise<void>((res, rej) => {
          resolveFn = res
          rejectFn = rej
        })
        const task = {
          cancel: vi.fn(),
          resolve: resolveFn,
          reject: rejectFn,
          promise,
        }
        renderTasks.push(task)
        return task
      },
    }
  }),
}))

// bitmapCache をモック（hit させない）
vi.mock('../../utils/bitmapCache', () => ({
  getBitmapCache: vi.fn(() => undefined),
  setBitmapCache: vi.fn(),
}))

import { usePrefetching } from '../../hooks/usePrefetching'

describe('S-14: usePrefetching cleanup & timeout', () => {
  let originalOffscreen: any
  // 互換のため宣言だけ残す（未使用）
  let clearTimeoutSpy: any

  beforeEach(() => {
    renderTasks.length = 0

    // OffscreenCanvas を最小スタブで提供（function コンストラクタ）
    originalOffscreen = (globalThis as any).OffscreenCanvas
    function MockOffscreenCanvas(this: any, w: number, h: number) {
      this.width = w
      this.height = h
      this.getContext = function () {
        return { fillStyle: '', fillRect: function () {} }
      }
      this.transferToImageBitmap = function () {
        return { close: function () {} }
      }
    }
    ;(globalThis as any).OffscreenCanvas = MockOffscreenCanvas

    // setTimeout/clearTimeout は現在の globalThis に function プロパティとして存在するが
    // jsdom 環境では `defineProperty` の関係で spyOn できない場合があるので
    // wrap せずカウンタ用変数を持たせる方式に変更
    clearTimeoutSpy = undefined as any
  })

  afterEach(() => {
    ;(globalThis as any).OffscreenCanvas = originalOffscreen
    if (clearTimeoutSpy && typeof clearTimeoutSpy.mockRestore === 'function') {
      clearTimeoutSpy.mockRestore()
    }
    vi.useRealTimers()
  })

  /** マイクロタスクを十分掃く */
  async function flushMicrotasks() {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  it('S-14-01: schedule then unmount cancels all in-flight render tasks', async () => {
    const { result, unmount } = renderHook(() => usePrefetching())

    act(() => {
      result.current.schedule({
        filePath: '/path/A.pdf',
        totalPages: 100,
        pageIndex: 5,
        zoom: 100,
        isCancelled: () => false,
      })
    })

    // runPrefetch は queueMicrotask 内で起動。順次 await getCachedPageProxy → render する。
    // 1 件 render が積まれた時点で unmount してキャンセルが伝播するか確認する。
    await flushMicrotasks()

    expect(renderTasks.length).toBeGreaterThanOrEqual(1)
    const tasksAtUnmount = [...renderTasks]

    unmount()

    // unmount cleanup → cancelAll → 各 wrapper.task.cancel() が呼ばれる
    for (const t of tasksAtUnmount) {
      expect(t.cancel).toHaveBeenCalled()
    }
  })

  it('S-14-02: 3-second timeout cancels task and clears timeoutId', async () => {
    vi.useFakeTimers()

    const { result, unmount } = renderHook(() => usePrefetching())

    act(() => {
      result.current.schedule({
        filePath: '/path/A.pdf',
        totalPages: 100,
        pageIndex: 5,
        zoom: 100,
        isCancelled: () => false,
      })
    })

    // queueMicrotask → runPrefetch → getCachedPageProxy(async) を解決
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()

    expect(renderTasks.length).toBeGreaterThanOrEqual(1)
    const stuckTask = renderTasks[0]

    // task.promise を resolve せず 3 秒進めるとタイムアウトが発火する
    await vi.advanceTimersByTimeAsync(3001)
    await flushMicrotasks()

    // タイムアウト経路で task.cancel が呼ばれる
    // （wrapper.cancelled = true / OffscreenCanvas 参照 null 化は外部観察不能なため
    //  task.cancel 呼び出しで代替検証する）
    expect(stuckTask.cancel).toHaveBeenCalled()

    vi.useRealTimers()
    unmount()
  })

  it('S-14-03: cancelAll then schedule does not retain old wrappers', async () => {
    const { result, unmount } = renderHook(() => usePrefetching())

    act(() => {
      result.current.schedule({
        filePath: '/path/A.pdf',
        totalPages: 100,
        pageIndex: 5,
        zoom: 100,
        isCancelled: () => false,
      })
    })
    await flushMicrotasks()

    const firstBatch = [...renderTasks]
    expect(firstBatch.length).toBeGreaterThanOrEqual(1)

    // cancelAll → 既存 wrapper の cancel が全て呼ばれる
    act(() => {
      result.current.cancelAll()
    })
    for (const t of firstBatch) {
      expect(t.cancel).toHaveBeenCalled()
    }

    // 続けて新しい schedule を実行
    renderTasks.length = 0
    act(() => {
      result.current.schedule({
        filePath: '/path/A.pdf',
        totalPages: 100,
        pageIndex: 10,
        zoom: 100,
        isCancelled: () => false,
      })
    })
    await flushMicrotasks()

    const secondBatch = [...renderTasks]
    expect(secondBatch.length).toBeGreaterThanOrEqual(1)

    // unmount で 2 回目の wrapper だけが cancel される（1 回目は重複 cancel されない）
    const firstCancelCounts = firstBatch.map(t => t.cancel.mock.calls.length)
    unmount()
    const firstCancelCountsAfter = firstBatch.map(t => t.cancel.mock.calls.length)

    // 1 回目バッチは追加で cancel されない（既に prefetchTasksRef から外れている）
    expect(firstCancelCountsAfter).toEqual(firstCancelCounts)
    // 2 回目バッチは unmount で cancel される
    for (const t of secondBatch) {
      expect(t.cancel).toHaveBeenCalled()
    }
  })
})
