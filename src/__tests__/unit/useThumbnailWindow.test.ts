/**
 * issue #35 回帰テスト
 *
 * 修正前: useThumbnailWindow の dirty-update useEffect が依存配列に
 *         [document, getDirtyPages] を持っていたため、document 全体購読により
 *         textBlocks 等 dirty に無関係な store 更新でも effect が再実行され、
 *         サムネイル窓未開でも編集 1 文字ごとに Tauri `emit('thumbnail:dirty-update')`
 *         が発火していた。
 * 修正後: dirty ページ一覧をシリアライズしたプリミティブのみを購読し、
 *         dirty 集合が変化したときだけ effect が走るようになった。
 *
 * 本テストは「textBlocks のみ変化させても emit('thumbnail:dirty-update') が
 * 増えないこと」「dirty 集合が変化したときだけ emit が走ること」を検証する。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'

// ── hoisted mocks ──────────────────────────────────────────────
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
  const getAllWindows = vi.fn().mockResolvedValue([])
  return { listen, emit, getAllWindows, listeners }
})

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: any[]) => m.listen(...args),
  emit: (...args: any[]) => m.emit(...args),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getAllWindows: (...args: any[]) => m.getAllWindows(...args),
}))

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: vi.fn(),
}))

// pdfLoader 由来の副作用を避ける（pecoStore が import している）
vi.mock('../../utils/pdfLoader', () => ({
  saveTemporaryPageDataBatch: vi.fn().mockResolvedValue(undefined),
  clearTemporaryChanges: vi.fn().mockResolvedValue(undefined),
}))

import { useThumbnailWindow } from '../../hooks/useThumbnailWindow'
import { usePecoStore } from '../../store/pecoStore'
import { useInfraStore } from '../../store/infraStore'
import type { PecoDocument, PageData, TextBlock } from '../../types'

function makeBlock(id: string, text: string, order: number): TextBlock {
  return {
    id,
    text,
    originalText: text,
    bbox: { x: 0, y: order * 20, width: 50, height: 16 },
    writingMode: 'horizontal',
    order,
    isNew: false,
    isDirty: false,
  }
}

function makePage(pageIndex: number, blocks: TextBlock[], isDirty = false, rotation?: 0 | 90 | 180 | 270): PageData {
  return {
    pageIndex,
    width: 100,
    height: 100,
    textBlocks: blocks,
    isDirty,
    thumbnail: null,
    ...(rotation !== undefined ? { rotation } : {}),
  }
}

function makeDoc(pages: PageData[], filePath = 'test.pdf'): PecoDocument {
  return {
    filePath,
    fileName: filePath.split(/[\\/]/).pop() ?? filePath,
    totalPages: pages.length,
    metadata: {},
    pages: new Map<number, PageData>(pages.map((p) => [p.pageIndex, p])),
    mtime: 1234,
  }
}

/** thumbnail:dirty-update emit の呼び出し回数を返す */
function dirtyEmitCount(): number {
  return m.emit.mock.calls.filter((c) => c[0] === 'thumbnail:dirty-update').length
}

function fileOpenedEmits(): any[] {
  return m.emit.mock.calls.filter((c) => c[0] === 'thumbnail:file-opened')
}

async function flushEffects() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('useThumbnailWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.listeners.clear()
    usePecoStore.setState({
      document: null,
      currentPageIndex: 0,
      pageOrder: [],
      selectedIds: new Set<string>(),
      undoStack: [],
      redoStack: [],
      isDirty: false,
    } as any)
    useInfraStore.setState({ documentEpoch: 0 })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  describe('issue #35 回帰: dirty 集合が変わらない store 更新で emit が走らない', () => {
    it('textBlocks のみ変化 (dirty 集合不変) では thumbnail:dirty-update emit が増えない', async () => {
      // 初期: 1 ページ、dirty=false
      usePecoStore.setState({
        document: makeDoc([makePage(0, [makeBlock('b1', 'hello', 0)])]),
        currentPageIndex: 0,
      } as any)

      renderHook(() => useThumbnailWindow())

      // 初回マウント時の effect / file-opened emit を flush
      await flushEffects()

      const baselineDirtyEmits = dirtyEmitCount()

      // textBlocks だけ変化させる (dirty フラグは変えない) を 5 回繰り返す
      for (let i = 0; i < 5; i++) {
        const text = 'hello' + 'x'.repeat(i + 1)
        act(() => {
          usePecoStore.setState({
            document: makeDoc([makePage(0, [makeBlock('b1', text, 0)])]),
          } as any)
        })
        await flushEffects()
      }

      // dirty 集合が変わっていないので emit は増えない
      expect(dirtyEmitCount()).toBe(baselineDirtyEmits)
    })

    it('dirty フラグが反転したときは thumbnail:dirty-update が emit される', async () => {
      // 初期: 1 ページ、dirty=false
      usePecoStore.setState({
        document: makeDoc([makePage(0, [makeBlock('b1', 'hello', 0)], false)]),
        currentPageIndex: 0,
      } as any)

      renderHook(() => useThumbnailWindow())

      await flushEffects()
      m.emit.mockClear()

      // ページを dirty にする
      act(() => {
        usePecoStore.setState({
          document: makeDoc([makePage(0, [makeBlock('b1', 'hello', 0)], true)]),
        } as any)
      })
      await flushEffects()

      // dirty 集合が変化したので thumbnail:dirty-update が少なくとも 1 回 emit され、
      // 最新の payload には dirtyPages: [0] が入っている
      const dirtyEmits = m.emit.mock.calls.filter(
        (c) => c[0] === 'thumbnail:dirty-update'
      )
      expect(dirtyEmits.length).toBeGreaterThanOrEqual(1)
      expect(dirtyEmits.at(-1)?.[1]).toEqual({ dirtyPages: [0] })
    })

    it('複数ページの dirty 集合が変化すると正しい dirtyPages が emit される', async () => {
      // 初期: 3 ページ全て dirty=false
      usePecoStore.setState({
        document: makeDoc([
          makePage(0, [], false),
          makePage(1, [], false),
          makePage(2, [], false),
        ]),
        currentPageIndex: 0,
      } as any)

      renderHook(() => useThumbnailWindow())

      await flushEffects()

      m.emit.mockClear()

      // ページ 0 と 2 を dirty にする
      act(() => {
        usePecoStore.setState({
          document: makeDoc([
            makePage(0, [], true),
            makePage(1, [], false),
            makePage(2, [], true),
          ]),
        } as any)
      })
      await flushEffects()

      const dirtyEmits = m.emit.mock.calls.filter(
        (c) => c[0] === 'thumbnail:dirty-update'
      )
      expect(dirtyEmits.length).toBeGreaterThanOrEqual(1)
      expect(dirtyEmits.at(-1)?.[1]).toEqual({ dirtyPages: [0, 2] })
    })
  })

  describe('PCT-010: thumbnail window に pageOrder を転送する', () => {
    it('thumbnail:file-opened payload に pageOrder を含める', async () => {
      usePecoStore.setState({
        document: makeDoc([
          makePage(0, [], false),
          makePage(1, [], false),
          makePage(2, [], false),
        ]),
        currentPageIndex: 1,
        pageOrder: [2, 0, 1],
      } as any)

      renderHook(() => useThumbnailWindow())
      await flushEffects()

      const fileOpenedEmits = m.emit.mock.calls.filter(
        (c) => c[0] === 'thumbnail:file-opened'
      )
      expect(fileOpenedEmits.at(-1)?.[1]).toMatchObject({
        documentEpoch: 0,
        currentPageIndex: 1,
        totalPages: 3,
        pageOrder: [2, 0, 1],
      })
    })

    it('thumbnail:request-state 応答 payload に pageOrder を含める', async () => {
      usePecoStore.setState({
        document: makeDoc([
          makePage(0, [], false),
          makePage(1, [], false),
          makePage(2, [], false),
        ]),
        currentPageIndex: 2,
        pageOrder: [1, 2, 0],
      } as any)

      renderHook(() => useThumbnailWindow())
      await flushEffects()
      m.emit.mockClear()

      const requestStateListener = m.listeners.get('thumbnail:request-state')?.[0]
      expect(requestStateListener).toBeDefined()
      requestStateListener()
      await flushEffects()

      expect(m.emit.mock.calls.at(-1)).toEqual([
        'thumbnail:file-opened',
        {
          filePath: 'test.pdf',
          documentEpoch: 0,
          currentPageIndex: 2,
          totalPages: 3,
          dirtyPages: [],
          pageOrder: [1, 2, 0],
          rotations: [0, 0, 0],
        },
      ])
    })

    it('pageOrder 変更時に thumbnail:page-order-changed を emit する', async () => {
      usePecoStore.setState({
        document: makeDoc([
          makePage(0, [], false),
          makePage(1, [], false),
          makePage(2, [], false),
        ]),
        currentPageIndex: 0,
        pageOrder: [0, 1, 2],
      } as any)

      renderHook(() => useThumbnailWindow())
      await flushEffects()
      m.emit.mockClear()

      act(() => {
        usePecoStore.setState({ pageOrder: [2, 0, 1] } as any)
      })
      await flushEffects()

      const pageOrderEmits = m.emit.mock.calls.filter(
        (c) => c[0] === 'thumbnail:page-order-changed'
      )
      expect(pageOrderEmits.at(-1)?.[1]).toEqual({
        currentPageIndex: 0,
        totalPages: 3,
        dirtyPages: [],
        pageOrder: [2, 0, 1],
        rotations: [0, 0, 0],
      })
      expect(fileOpenedEmits()).toHaveLength(0)
    })
  })

  describe('PCT-033: document.totalPages 変更を thumbnail window に通知する', () => {
    it('ページ削除時の pageOrder 変更イベントに新しい totalPages/currentPageIndex を含める', async () => {
      usePecoStore.setState({
        document: makeDoc([
          makePage(0, [], false),
          makePage(1, [], false),
          makePage(2, [], false),
        ]),
        currentPageIndex: 2,
        pageOrder: [0, 1, 2],
      } as any)

      renderHook(() => useThumbnailWindow())
      await flushEffects()
      m.emit.mockClear()

      act(() => {
        usePecoStore.setState({
          document: makeDoc([
            makePage(0, [], false),
            makePage(1, [], true),
          ]),
          currentPageIndex: 1,
          pageOrder: [0, 2],
        } as any)
      })
      await flushEffects()

      expect(fileOpenedEmits()).toHaveLength(0)
      const pageOrderEmits = m.emit.mock.calls.filter(
        (c) => c[0] === 'thumbnail:page-order-changed'
      )
      expect(pageOrderEmits).toHaveLength(1)
      expect(pageOrderEmits[0][1]).toEqual({
        currentPageIndex: 1,
        totalPages: 2,
        dirtyPages: [1],
        pageOrder: [0, 2],
        rotations: [0, 0],
      })
    })
  })

  describe('PCT-018: documentEpoch 変更を thumbnail window に通知する', () => {
    it('同一 filePath の documentEpoch 変更で thumbnail:file-opened を emit する', async () => {
      useInfraStore.setState({ documentEpoch: 1 })
      usePecoStore.setState({
        document: makeDoc([
          makePage(0, [], false),
          makePage(1, [], false),
        ]),
        currentPageIndex: 1,
        pageOrder: [0, 1],
      } as any)

      renderHook(() => useThumbnailWindow())
      await flushEffects()
      m.emit.mockClear()

      act(() => {
        useInfraStore.setState({ documentEpoch: 2 })
      })
      await flushEffects()

      expect(fileOpenedEmits()).toHaveLength(1)
      expect(fileOpenedEmits().at(-1)?.[1]).toEqual({
        filePath: 'test.pdf',
        documentEpoch: 2,
        currentPageIndex: 1,
        totalPages: 2,
        dirtyPages: [],
        pageOrder: [0, 1],
        rotations: [0, 0],
      })
      expect(
        m.emit.mock.calls.filter((c) => c[0] === 'thumbnail:page-order-changed')
      ).toHaveLength(0)
    })

    it('filePath 変更時の thumbnail:file-opened emit を維持する', async () => {
      useInfraStore.setState({ documentEpoch: 5 })
      usePecoStore.setState({
        document: makeDoc([makePage(0, [], false)], 'before.pdf'),
        currentPageIndex: 0,
        pageOrder: [0],
      } as any)

      renderHook(() => useThumbnailWindow())
      await flushEffects()
      m.emit.mockClear()

      act(() => {
        usePecoStore.setState({
          document: makeDoc([
            makePage(0, [], false),
            makePage(1, [], true),
          ], 'after.pdf'),
          currentPageIndex: 1,
          pageOrder: [1, 0],
        } as any)
      })
      await flushEffects()

      expect(fileOpenedEmits()).toHaveLength(1)
      expect(fileOpenedEmits().at(-1)?.[1]).toEqual({
        filePath: 'after.pdf',
        documentEpoch: 5,
        currentPageIndex: 1,
        totalPages: 2,
        dirtyPages: [1],
        pageOrder: [1, 0],
        rotations: [0, 0],
      })
    })
  })

  describe('issue #431 (PCT-200 / FB-6): 別ウィンドウサムネイルに UI 回転を反映する', () => {
    it('thumbnail:file-opened payload の rotations は pageOrder (表示順) に沿って source page の rotation を並べる', async () => {
      usePecoStore.setState({
        document: makeDoc([
          makePage(0, [], false, 90),
          makePage(1, [], false, 0),
          makePage(2, [], false, 270),
        ]),
        currentPageIndex: 0,
        // 表示順: [page2, page0, page1] → rotations は [270, 90, 0] になるはず
        pageOrder: [2, 0, 1],
      } as any)

      renderHook(() => useThumbnailWindow())
      await flushEffects()

      expect(fileOpenedEmits().at(-1)?.[1]).toMatchObject({
        pageOrder: [2, 0, 1],
        rotations: [270, 90, 0],
      })
    })

    it('rotation のみ変化 (pageOrder/dirty 不変) すると thumbnail:rotation-update が表示順 payload で emit される', async () => {
      usePecoStore.setState({
        document: makeDoc([
          makePage(0, [], false, 0),
          makePage(1, [], false, 0),
        ]),
        currentPageIndex: 0,
        pageOrder: [0, 1],
      } as any)

      renderHook(() => useThumbnailWindow())
      await flushEffects()
      m.emit.mockClear()

      // page 1 だけ回転させる (pageOrder は不変)
      act(() => {
        usePecoStore.setState({
          document: makeDoc([
            makePage(0, [], false, 0),
            makePage(1, [], false, 90),
          ]),
        } as any)
      })
      await flushEffects()

      const rotationEmits = m.emit.mock.calls.filter((c) => c[0] === 'thumbnail:rotation-update')
      expect(rotationEmits.length).toBeGreaterThanOrEqual(1)
      expect(rotationEmits.at(-1)?.[1]).toEqual({ rotations: [0, 90] })
      // pageOrder/totalPages 再構成の file-opened / page-order-changed は飛ばない (軽量パス)
      expect(fileOpenedEmits()).toHaveLength(0)
      expect(
        m.emit.mock.calls.filter((c) => c[0] === 'thumbnail:page-order-changed')
      ).toHaveLength(0)
    })

    it('rotation が変化しない store 更新では thumbnail:rotation-update が増えない', async () => {
      usePecoStore.setState({
        document: makeDoc([makePage(0, [makeBlock('b1', 'hello', 0)], false, 0)]),
        currentPageIndex: 0,
        pageOrder: [0],
      } as any)

      renderHook(() => useThumbnailWindow())
      await flushEffects()

      const baseline = m.emit.mock.calls.filter((c) => c[0] === 'thumbnail:rotation-update').length

      // textBlocks だけ変化 (rotation は不変)
      act(() => {
        usePecoStore.setState({
          document: makeDoc([makePage(0, [makeBlock('b1', 'HELLO', 0)], false, 0)]),
        } as any)
      })
      await flushEffects()

      expect(
        m.emit.mock.calls.filter((c) => c[0] === 'thumbnail:rotation-update').length
      ).toBe(baseline)
    })
  })
})
