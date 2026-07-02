import { render, waitFor, act, cleanup } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ThumbnailWindow } from '../../components/ThumbnailWindow/ThumbnailWindow'

const m = vi.hoisted(() => {
  const listeners = new Map<string, any[]>()
  const listen = vi.fn(async (eventName: string, cb: any) => {
    if (!listeners.has(eventName)) listeners.set(eventName, [])
    listeners.get(eventName)!.push(cb)
    return () => {
      const cbs = listeners.get(eventName) ?? []
      listeners.set(eventName, cbs.filter((x) => x !== cb))
    }
  })
  const emit = vi.fn().mockResolvedValue(undefined)
  const hide = vi.fn().mockResolvedValue(undefined)
  const onCloseRequested = vi.fn().mockResolvedValue(() => {})
  return { listeners, listen, emit, hide, onCloseRequested }
})

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: any[]) => m.listen(...args),
  emit: (...args: any[]) => m.emit(...args),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onCloseRequested: m.onCloseRequested,
    hide: m.hide,
  }),
}))

vi.mock('react-virtuoso', () => {
  const React = require('react') as typeof import('react')
  const Virtuoso = React.forwardRef(function Virtuoso(
    { totalCount, itemContent, style }: any,
    ref: any
  ) {
    React.useImperativeHandle(ref, () => ({
      scrollIntoView: vi.fn(),
    }))
    return (
      <div style={style}>
        {Array.from({ length: totalCount }, (_, i) => (
          <div key={i}>{itemContent(i)}</div>
        ))}
      </div>
    )
  })
  return { Virtuoso }
})

class MockThumbnailWorker {
  static instances: MockThumbnailWorker[] = []
  static autoLoadComplete = true
  static autoThumbnailDone = false
  onmessage: ((e: MessageEvent<any>) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  messages: any[] = []

  constructor() {
    MockThumbnailWorker.instances.push(this)
  }

  postMessage(req: any) {
    this.messages.push(req)
    if (req?.type === 'LOAD_PDF' && MockThumbnailWorker.autoLoadComplete) {
      queueMicrotask(() => {
        this.onmessage?.({ data: { type: 'LOAD_COMPLETE', numPages: 3, requestId: req.requestId } } as MessageEvent<any>)
      })
    }
    if (req?.type === 'GENERATE_THUMBNAIL' && MockThumbnailWorker.autoThumbnailDone) {
      queueMicrotask(() => {
        this.onmessage?.({
          data: {
            type: 'THUMBNAIL_DONE',
            pageIndex: req.pageIndex,
            bytes: new Uint8Array([1, 2, 3]),
            requestId: req.requestId,
          },
        } as MessageEvent<any>)
      })
    }
  }

  terminate() {}
}

async function flushEffects() {
  await Promise.resolve()
  await Promise.resolve()
}

function workerMessages(type: string) {
  return MockThumbnailWorker.instances.flatMap((w) =>
    w.messages.filter((msg) => msg?.type === type)
  )
}

function completeAllLoads() {
  for (const worker of MockThumbnailWorker.instances) {
    const load = worker.messages.findLast((msg) => msg?.type === 'LOAD_PDF')
    worker.onmessage?.({ data: { type: 'LOAD_COMPLETE', numPages: 3, requestId: load?.requestId } } as MessageEvent<any>)
  }
}

function deliverThumbnail(worker: MockThumbnailWorker, req: any) {
  worker.onmessage?.({
    data: {
      type: 'THUMBNAIL_DONE',
      pageIndex: req.pageIndex,
      bytes: new Uint8Array([1, 2, 3]),
      requestId: req.requestId,
    },
  } as MessageEvent<any>)
}

describe('ThumbnailWindow', () => {
  let originalWorker: any
  let originalFetch: any

  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    m.listeners.clear()
    MockThumbnailWorker.instances = []
    MockThumbnailWorker.autoLoadComplete = true
    MockThumbnailWorker.autoThumbnailDone = false

    originalWorker = (globalThis as any).Worker
    ;(globalThis as any).Worker = MockThumbnailWorker as any
    if (typeof window !== 'undefined') {
      ;(window as any).Worker = MockThumbnailWorker as any
    }

    originalFetch = (globalThis as any).fetch
    ;(globalThis as any).fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    }))
  })

  afterEach(() => {
    cleanup()
    ;(globalThis as any).Worker = originalWorker
    if (typeof window !== 'undefined') {
      ;(window as any).Worker = originalWorker
    }
    ;(globalThis as any).fetch = originalFetch
  })

  it('GENERATE_THUMBNAIL に display pageIndex と pageOrder 由来の sourcePageIndex を渡す', async () => {
    render(<ThumbnailWindow />)

    await waitFor(() => expect(m.listeners.get('thumbnail:file-opened')?.[0]).toBeDefined())

    act(() => {
      m.listeners.get('thumbnail:file-opened')![0]({
        payload: {
          filePath: 'test.pdf',
          currentPageIndex: 0,
          totalPages: 3,
          dirtyPages: [],
          pageOrder: [2, 0, 1],
        },
      })
    })
    await flushEffects()

    await waitFor(() => {
      expect(workerMessages('GENERATE_THUMBNAIL').length).toBeGreaterThanOrEqual(3)
    })

    expect(workerMessages('GENERATE_THUMBNAIL')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pageIndex: 0, sourcePageIndex: 2 }),
        expect.objectContaining({ pageIndex: 1, sourcePageIndex: 0 }),
        expect.objectContaining({ pageIndex: 2, sourcePageIndex: 1 }),
      ])
    )
  })

  it('LOAD_PDF はArrayBuffer複製ではなくURLをWorkerへ渡す', async () => {
    render(<ThumbnailWindow />)

    await waitFor(() => expect(m.listeners.get('thumbnail:file-opened')?.[0]).toBeDefined())

    act(() => {
      m.listeners.get('thumbnail:file-opened')![0]({
        payload: {
          filePath: 'test.pdf',
          currentPageIndex: 0,
          totalPages: 3,
          dirtyPages: [],
          pageOrder: [0, 1, 2],
        },
      })
    })
    await flushEffects()

    expect((globalThis as any).fetch).not.toHaveBeenCalled()
    expect(workerMessages('LOAD_PDF')).toHaveLength(3)
    expect(workerMessages('LOAD_PDF')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'LOAD_PDF', url: expect.stringContaining('test.pdf') }),
      ])
    )
    expect(workerMessages('LOAD_PDF').some((msg) => 'bytes' in msg)).toBe(false)
  })

  it('初回LOAD_PDF完了前にpageOrderが変わってもロード完了後に新pageOrderで生成する', async () => {
    MockThumbnailWorker.autoLoadComplete = false
    render(<ThumbnailWindow />)

    await waitFor(() => expect(m.listeners.get('thumbnail:file-opened')?.[0]).toBeDefined())

    act(() => {
      m.listeners.get('thumbnail:file-opened')![0]({
        payload: {
          filePath: 'test.pdf',
          currentPageIndex: 0,
          totalPages: 3,
          dirtyPages: [],
          pageOrder: [0, 1, 2],
        },
      })
    })
    await flushEffects()

    act(() => {
      m.listeners.get('thumbnail:page-order-changed')![0]({
        payload: {
          currentPageIndex: 0,
          totalPages: 3,
          dirtyPages: [],
          pageOrder: [2, 0, 1],
        },
      })
    })
    await flushEffects()

    expect(workerMessages('GENERATE_THUMBNAIL')).toHaveLength(0)

    act(() => {
      completeAllLoads()
    })

    await waitFor(() => {
      expect(workerMessages('GENERATE_THUMBNAIL').length).toBeGreaterThanOrEqual(3)
    })
    expect(workerMessages('GENERATE_THUMBNAIL')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pageIndex: 0, sourcePageIndex: 2 }),
        expect.objectContaining({ pageIndex: 1, sourcePageIndex: 0 }),
        expect.objectContaining({ pageIndex: 2, sourcePageIndex: 1 }),
      ])
    )
  })

  it('unmount時に保持済みObjectURLをrevokeする', async () => {
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    let nextUrl = 0
    const revoke = vi.fn()
    URL.createObjectURL = vi.fn(() => `blob:test-${nextUrl++}`)
    URL.revokeObjectURL = revoke
    MockThumbnailWorker.autoThumbnailDone = true

    const rendered = render(<ThumbnailWindow />)

    await waitFor(() => expect(m.listeners.get('thumbnail:file-opened')?.[0]).toBeDefined())

    act(() => {
      m.listeners.get('thumbnail:file-opened')![0]({
        payload: {
          filePath: 'test.pdf',
          currentPageIndex: 0,
          totalPages: 3,
          dirtyPages: [],
          pageOrder: [0, 1, 2],
        },
      })
    })

    await waitFor(() => {
      expect(URL.createObjectURL).toHaveBeenCalled()
    })

    rendered.unmount()

    expect(revoke).toHaveBeenCalled()

    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
  })

  it('pageOrder変更前の旧応答は変更後の同じdisplay page pendingを解決しない', async () => {
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    URL.createObjectURL = vi.fn(() => 'blob:new')
    URL.revokeObjectURL = vi.fn()

    render(<ThumbnailWindow />)

    await waitFor(() => expect(m.listeners.get('thumbnail:file-opened')?.[0]).toBeDefined())

    act(() => {
      m.listeners.get('thumbnail:file-opened')![0]({
        payload: {
          filePath: 'test.pdf',
          currentPageIndex: 0,
          totalPages: 3,
          dirtyPages: [],
          pageOrder: [0, 1, 2],
        },
      })
    })

    await waitFor(() => {
      expect(workerMessages('GENERATE_THUMBNAIL').length).toBeGreaterThanOrEqual(3)
    })

    const worker = MockThumbnailWorker.instances[0]
    const staleReq = worker.messages.find((msg) => msg?.type === 'GENERATE_THUMBNAIL' && msg.pageIndex === 0)

    act(() => {
      m.listeners.get('thumbnail:page-order-changed')![0]({
        payload: {
          currentPageIndex: 0,
          totalPages: 3,
          dirtyPages: [],
          pageOrder: [2, 0, 1],
        },
      })
    })

    await waitFor(() => {
      const page0Reqs = worker.messages.filter((msg) => msg?.type === 'GENERATE_THUMBNAIL' && msg.pageIndex === 0)
      expect(page0Reqs.length).toBeGreaterThanOrEqual(2)
    })

    const page0Reqs = worker.messages.filter((msg) => msg?.type === 'GENERATE_THUMBNAIL' && msg.pageIndex === 0)
    const freshReq = page0Reqs.at(-1)!
    expect(freshReq.requestId).not.toBe(staleReq.requestId)
    expect(freshReq.sourcePageIndex).toBe(2)

    act(() => {
      deliverThumbnail(worker, staleReq)
    })
    await flushEffects()
    expect(URL.createObjectURL).not.toHaveBeenCalled()

    act(() => {
      deliverThumbnail(worker, freshReq)
    })
    await waitFor(() => {
      expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
      expect(document.querySelector('img[alt="Page 1"]')).not.toBeNull()
    })

    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
  })

  it('ファイル切替前の旧応答は新ファイルの同じdisplay page pendingを解決しない', async () => {
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    URL.createObjectURL = vi.fn(() => 'blob:new-file')
    URL.revokeObjectURL = vi.fn()

    render(<ThumbnailWindow />)

    await waitFor(() => expect(m.listeners.get('thumbnail:file-opened')?.[0]).toBeDefined())

    act(() => {
      m.listeners.get('thumbnail:file-opened')![0]({
        payload: {
          filePath: 'a.pdf',
          currentPageIndex: 0,
          totalPages: 3,
          dirtyPages: [],
          pageOrder: [0, 1, 2],
        },
      })
    })

    await waitFor(() => {
      expect(workerMessages('GENERATE_THUMBNAIL').length).toBeGreaterThanOrEqual(3)
    })

    const worker = MockThumbnailWorker.instances[0]
    const staleReq = worker.messages.find((msg) => msg?.type === 'GENERATE_THUMBNAIL' && msg.pageIndex === 0)

    act(() => {
      m.listeners.get('thumbnail:file-opened')![0]({
        payload: {
          filePath: 'b.pdf',
          currentPageIndex: 0,
          totalPages: 3,
          dirtyPages: [],
          pageOrder: [0, 1, 2],
        },
      })
    })

    await waitFor(() => {
      const page0Reqs = worker.messages.filter((msg) => msg?.type === 'GENERATE_THUMBNAIL' && msg.pageIndex === 0)
      expect(page0Reqs.length).toBeGreaterThanOrEqual(2)
    })

    const page0Reqs = worker.messages.filter((msg) => msg?.type === 'GENERATE_THUMBNAIL' && msg.pageIndex === 0)
    const freshReq = page0Reqs.at(-1)!
    expect(freshReq.requestId).not.toBe(staleReq.requestId)

    act(() => {
      deliverThumbnail(worker, staleReq)
    })
    await flushEffects()
    expect(URL.createObjectURL).not.toHaveBeenCalled()

    act(() => {
      deliverThumbnail(worker, freshReq)
    })
    await waitFor(() => {
      expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
      expect(document.querySelector('img[alt="Page 1"]')).not.toBeNull()
    })

    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
  })

  it('pageOrder 更新時に古い作業を破棄して新しい sourcePageIndex で再生成する', async () => {
    render(<ThumbnailWindow />)

    await waitFor(() => expect(m.listeners.get('thumbnail:file-opened')?.[0]).toBeDefined())

    act(() => {
      m.listeners.get('thumbnail:file-opened')![0]({
        payload: {
          filePath: 'test.pdf',
          currentPageIndex: 0,
          totalPages: 3,
          dirtyPages: [],
          pageOrder: [0, 1, 2],
        },
      })
    })

    await waitFor(() => {
      expect(workerMessages('GENERATE_THUMBNAIL').length).toBeGreaterThanOrEqual(3)
    })

    const firstGenerateCount = workerMessages('GENERATE_THUMBNAIL').length

    act(() => {
      m.listeners.get('thumbnail:page-order-changed')![0]({
        payload: {
          currentPageIndex: 0,
          totalPages: 3,
          dirtyPages: [],
          pageOrder: [2, 0, 1],
        },
      })
    })
    await flushEffects()

    await waitFor(() => {
      expect(workerMessages('GENERATE_THUMBNAIL').length).toBeGreaterThan(firstGenerateCount)
    })

    expect(workerMessages('GENERATE_THUMBNAIL')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pageIndex: 0, sourcePageIndex: 2 }),
        expect.objectContaining({ pageIndex: 1, sourcePageIndex: 0 }),
        expect.objectContaining({ pageIndex: 2, sourcePageIndex: 1 }),
      ])
    )
  })

  it('PCT-073: thumbnail:file-closed で全 worker に CLOSE_PDF を post する', async () => {
    render(<ThumbnailWindow />)

    await waitFor(() => expect(m.listeners.get('thumbnail:file-closed')?.[0]).toBeDefined())

    act(() => {
      m.listeners.get('thumbnail:file-opened')![0]({
        payload: {
          filePath: 'test.pdf',
          currentPageIndex: 0,
          totalPages: 3,
          dirtyPages: [],
          pageOrder: [0, 1, 2],
        },
      })
    })
    await flushEffects()
    // ファイルを開いている間は CLOSE_PDF は送られない
    expect(workerMessages('CLOSE_PDF')).toHaveLength(0)

    act(() => {
      m.listeners.get('thumbnail:file-closed')![0]({})
    })
    await flushEffects()

    // 全 worker (NUM_WORKERS=3) に 1 通ずつ届く（worker 内の pdfDoc 残留リーク防止）
    expect(workerMessages('CLOSE_PDF')).toHaveLength(3)
    for (const worker of MockThumbnailWorker.instances) {
      expect(worker.messages.filter((msg) => msg?.type === 'CLOSE_PDF')).toHaveLength(1)
    }
  })

  it('PCT-033: ページ削除時に表示件数を縮め、削除済みdisplay indexを再要求しない', async () => {
    render(<ThumbnailWindow />)

    await waitFor(() => expect(m.listeners.get('thumbnail:file-opened')?.[0]).toBeDefined())

    act(() => {
      m.listeners.get('thumbnail:file-opened')![0]({
        payload: {
          filePath: 'test.pdf',
          currentPageIndex: 2,
          totalPages: 3,
          dirtyPages: [],
          pageOrder: [0, 1, 2],
        },
      })
    })

    await waitFor(() => {
      expect(document.querySelectorAll('.thumbnail-item')).toHaveLength(3)
      expect(document.querySelector('.thumbnail-item.active .thumbnail-label')?.textContent).toContain('3 ページ')
    })
    await waitFor(() => {
      expect(workerMessages('GENERATE_THUMBNAIL').length).toBeGreaterThanOrEqual(3)
    })

    const messageCounts = MockThumbnailWorker.instances.map((worker) => worker.messages.length)

    act(() => {
      m.listeners.get('thumbnail:page-order-changed')![0]({
        payload: {
          currentPageIndex: 1,
          totalPages: 2,
          dirtyPages: [1],
          pageOrder: [0, 2],
        },
      })
    })

    await waitFor(() => {
      const labels = Array.from(document.querySelectorAll('.thumbnail-label')).map((el) => el.textContent ?? '')
      expect(document.querySelectorAll('.thumbnail-item')).toHaveLength(2)
      expect(document.querySelector('.thumbnail-item.active .thumbnail-label')?.textContent).toContain('2 ページ')
      expect(labels.some((label) => label.includes('3 ページ'))).toBe(false)
    })

    await waitFor(() => {
      const newGenerates = MockThumbnailWorker.instances.flatMap((worker, index) =>
        worker.messages.slice(messageCounts[index]).filter((msg) => msg?.type === 'GENERATE_THUMBNAIL')
      )
      expect(newGenerates.length).toBeGreaterThanOrEqual(2)
    })

    const newGenerates = MockThumbnailWorker.instances.flatMap((worker, index) =>
      worker.messages.slice(messageCounts[index]).filter((msg) => msg?.type === 'GENERATE_THUMBNAIL')
    )
    expect(newGenerates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pageIndex: 0, sourcePageIndex: 0 }),
        expect.objectContaining({ pageIndex: 1, sourcePageIndex: 2 }),
      ])
    )
    expect(newGenerates.some((msg) => msg.pageIndex === 2)).toBe(false)
  })

  describe('issue #431 (PCT-200 / FB-6): UI 回転の反映', () => {
    it('thumbnail:file-opened の rotations が --thumbnail-rotation / --thumb-box-w の CSS variable に反映される', async () => {
      render(<ThumbnailWindow />)

      await waitFor(() => expect(m.listeners.get('thumbnail:file-opened')?.[0]).toBeDefined())

      act(() => {
        m.listeners.get('thumbnail:file-opened')![0]({
          payload: {
            filePath: 'test.pdf',
            currentPageIndex: 0,
            totalPages: 3,
            dirtyPages: [],
            pageOrder: [0, 1, 2],
            // page0: 回転なし, page1: 90度 (landscape), page2: 180度 (portrait のまま)
            rotations: [0, 90, 180],
          },
        })
      })
      await flushEffects()

      const boxes = document.querySelectorAll('.thumbnail-box')
      expect(boxes).toHaveLength(3)

      // page0 (rotation=0): variable は未設定
      expect((boxes[0] as HTMLElement).style.getPropertyValue('--thumb-box-w')).toBe('')

      // page1 (rotation=90, landscape): 幅高さがスワップされる
      expect((boxes[1] as HTMLElement).style.getPropertyValue('--thumb-box-w')).toBe('160px')
      expect((boxes[1] as HTMLElement).style.getPropertyValue('--thumb-box-h')).toBe('120px')

      // page2 (rotation=180): landscape ではないので box variable は未設定
      expect((boxes[2] as HTMLElement).style.getPropertyValue('--thumb-box-w')).toBe('')
    })

    it('thumbnail:rotation-update を受信すると既存表示の回転が更新される', async () => {
      render(<ThumbnailWindow />)

      await waitFor(() => expect(m.listeners.get('thumbnail:file-opened')?.[0]).toBeDefined())

      act(() => {
        m.listeners.get('thumbnail:file-opened')![0]({
          payload: {
            filePath: 'test.pdf',
            currentPageIndex: 0,
            totalPages: 2,
            dirtyPages: [],
            pageOrder: [0, 1],
            rotations: [0, 0],
          },
        })
      })
      await flushEffects()

      await waitFor(() => expect(m.listeners.get('thumbnail:rotation-update')?.[0]).toBeDefined())

      act(() => {
        m.listeners.get('thumbnail:rotation-update')![0]({
          payload: { rotations: [270, 0] },
        })
      })
      await flushEffects()

      const boxes = document.querySelectorAll('.thumbnail-box')
      // page0 が 270度 (landscape) に変わったので box variable がスワップされる
      expect((boxes[0] as HTMLElement).style.getPropertyValue('--thumb-box-w')).toBe('160px')
      expect((boxes[0] as HTMLElement).style.getPropertyValue('--thumb-box-h')).toBe('120px')
      // page1 は回転なしのまま
      expect((boxes[1] as HTMLElement).style.getPropertyValue('--thumb-box-w')).toBe('')
    })
  })
})
