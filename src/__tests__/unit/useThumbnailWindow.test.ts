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
    it('thumbnail:file-opened payload の rotations は表示順 (displayIndex) の rotation を並べる', async () => {
      // 本番の pages Map は displayIndex キー (movePage/deletePages/reorder undo が
      // display で再構築、pageIndex フィールドも displayIndex に揃う)。並べ替え後
      // pageOrder=[2,0,1] のとき、表示スロット0=元page2(270°)/1=元page0(90°)/2=元page1(0°)。
      // makeDoc は pageIndex をキーにするため、rotation は displayIndex スロットで与える。
      usePecoStore.setState({
        document: makeDoc([
          makePage(0, [], false, 270), // 表示スロット0 (元 page2)
          makePage(1, [], false, 90),  // 表示スロット1 (元 page0)
          makePage(2, [], false, 0),   // 表示スロット2 (元 page1)
        ]),
        currentPageIndex: 0,
        pageOrder: [2, 0, 1],
      } as any)

      renderHook(() => useThumbnailWindow())
      await flushEffects()

      expect(fileOpenedEmits().at(-1)?.[1]).toMatchObject({
        pageOrder: [2, 0, 1],
        rotations: [270, 90, 0],
      })
    })

    it('回帰(B-2): 並べ替え後に source-index で引くと別ページの rotation を返す誤りを検出する', async () => {
      // pageOrder が identity でない状態で、displayIndex 引きと source 引きが分岐する fixture。
      // displayIndex キーの pages: slot0=0°, slot1=90°, slot2=0°。pageOrder=[2,0,1]。
      // 正しい表示順 rotations は [slot0, slot1, slot2] = [0, 90, 0]。
      // 旧実装 pageOrder.map(src => get(src)) だと get(2),get(0),get(1)=[0,0,90] になり不一致。
      usePecoStore.setState({
        document: makeDoc([
          makePage(0, [], false, 0),
          makePage(1, [], false, 90),
          makePage(2, [], false, 0),
        ]),
        currentPageIndex: 0,
        pageOrder: [2, 0, 1],
      } as any)

      renderHook(() => useThumbnailWindow())
      await flushEffects()

      expect(fileOpenedEmits().at(-1)?.[1]).toMatchObject({
        pageOrder: [2, 0, 1],
        rotations: [0, 90, 0],
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

  describe('R22狩りWave4 (C-9回帰): 窓マウント時の request-state 応答と doc-open effect の近接二重発火を防ぐ', () => {
    it('同一tick内でrequest-stateに応答してもthumbnail:file-openedは1回しかemitされない', async () => {
      // 修正前は、窓マウント時の request-state 応答 (thumbnail:request-state
      // リスナー) と doc-open 由来の effect emit が近接して両方走ると、
      // 同一 (filePath, documentEpoch) に対して thumbnail:file-opened が
      // 2連発していた (別窓側で LOAD_PDF が二重に走る)。
      usePecoStore.setState({
        document: makeDoc([makePage(0, [], false)]),
        currentPageIndex: 0,
        pageOrder: [0],
      } as any)

      renderHook(() => useThumbnailWindow())

      // マウント直後、マイクロタスクを一つも消化しないうちに、別窓側から
      // 実際に届く thumbnail:request-state イベントを模擬して即座に呼び出す。
      // doc-open effect が同期的に emit した直後、デデュープキーの解除
      // (マイクロタスクで解除) がまだ走っていないタイミングで request-state
      // 応答が重なる近接ケースを再現する。
      const requestStateListener = m.listeners.get('thumbnail:request-state')?.[0]
      requestStateListener?.()

      await flushEffects()

      expect(fileOpenedEmits()).toHaveLength(1)
    })

    it('epoch bump 後 (別タイミング) は改めて thumbnail:file-opened が emit される', async () => {
      usePecoStore.setState({
        document: makeDoc([makePage(0, [], false)]),
        currentPageIndex: 0,
        pageOrder: [0],
      } as any)

      renderHook(() => useThumbnailWindow())
      await flushEffects()
      m.emit.mockClear()

      act(() => {
        useInfraStore.setState({ documentEpoch: 1 })
      })
      await flushEffects()

      expect(fileOpenedEmits()).toHaveLength(1)
      expect(fileOpenedEmits()[0]?.[1]).toMatchObject({ documentEpoch: 1 })
    })
  })

  describe('R22狩りWave4 (C-4軽減回帰): 非表示の別窓への file-opened emit を保留し、再表示時に1回だけ flush する', () => {
    function makeFakeThumbnailWindow(initialVisible: boolean) {
      return {
        label: 'thumbnail-window',
        isVisible: vi.fn().mockResolvedValue(initialVisible),
        show: vi.fn().mockResolvedValue(undefined),
        hide: vi.fn().mockResolvedValue(undefined),
        setFocus: vi.fn().mockResolvedValue(undefined),
      }
    }

    it('非表示中の epoch bump は file-opened を emit せず、再表示 (toggle) 時に1回だけ flush される', async () => {
      const fakeWin = makeFakeThumbnailWindow(true)
      m.getAllWindows.mockResolvedValue([fakeWin])

      usePecoStore.setState({
        document: makeDoc([makePage(0, [], false)]),
        currentPageIndex: 0,
        pageOrder: [0],
      } as any)

      const { result } = renderHook(() => useThumbnailWindow())
      await flushEffects()

      // 窓を生成・表示状態にする (thumbWinRef をセットする)
      await act(async () => {
        await result.current.toggleThumbnailWindow()
      })
      await flushEffects()
      expect(result.current.isThumbnailOpen).toBe(true)

      m.emit.mockClear()

      // × ボタン相当: 窓を非表示にする
      fakeWin.isVisible.mockResolvedValue(false)
      await act(async () => {
        await result.current.toggleThumbnailWindow()
      })
      await flushEffects()
      expect(result.current.isThumbnailOpen).toBe(false)

      // 非表示中に上書き保存等で epoch が進む (修正前は LOAD_PDF ×3 が無条件で走っていた)
      act(() => {
        useInfraStore.setState({ documentEpoch: 1 })
      })
      await flushEffects()
      await flushEffects()

      // 非表示中は file-opened が emit されない
      expect(fileOpenedEmits()).toHaveLength(0)

      // 再表示すると、保留していた最新状態が1回だけ flush される
      fakeWin.isVisible.mockResolvedValue(true)
      await act(async () => {
        await result.current.toggleThumbnailWindow()
      })
      await flushEffects()
      await flushEffects()

      const emitsAfterShow = fileOpenedEmits()
      expect(emitsAfterShow).toHaveLength(1)
      expect(emitsAfterShow[0]?.[1]).toMatchObject({ documentEpoch: 1 })
    })

    it('非表示中に epoch が2回進んでも、再表示時の flush は最新1回分だけでよい', async () => {
      const fakeWin = makeFakeThumbnailWindow(true)
      m.getAllWindows.mockResolvedValue([fakeWin])

      usePecoStore.setState({
        document: makeDoc([makePage(0, [], false)]),
        currentPageIndex: 0,
        pageOrder: [0],
      } as any)

      const { result } = renderHook(() => useThumbnailWindow())
      await flushEffects()

      await act(async () => {
        await result.current.toggleThumbnailWindow()
      })
      await flushEffects()

      fakeWin.isVisible.mockResolvedValue(false)
      await act(async () => {
        await result.current.toggleThumbnailWindow()
      })
      await flushEffects()

      m.emit.mockClear()

      act(() => {
        useInfraStore.setState({ documentEpoch: 1 })
      })
      await flushEffects()
      await flushEffects()

      act(() => {
        useInfraStore.setState({ documentEpoch: 2 })
      })
      await flushEffects()
      await flushEffects()

      expect(fileOpenedEmits()).toHaveLength(0)

      fakeWin.isVisible.mockResolvedValue(true)
      await act(async () => {
        await result.current.toggleThumbnailWindow()
      })
      await flushEffects()
      await flushEffects()

      const emitsAfterShow = fileOpenedEmits()
      expect(emitsAfterShow).toHaveLength(1)
      expect(emitsAfterShow[0]?.[1]).toMatchObject({ documentEpoch: 2 })
    })
  })

  describe('R22狩りWave4 (C-10回帰): dirty/rotation シリアライズのメモ化が正しい値を保つ', () => {
    it('pages Map 参照が同一のまま無関係な store 更新があっても dirty-update は増えず、実際に dirty が変化した時は正しい値が emit される', async () => {
      const pages = new Map([
        [0, makePage(0, [], false)],
        [1, makePage(1, [], false)],
      ])
      usePecoStore.setState({
        document: {
          filePath: 'cache.pdf',
          fileName: 'cache.pdf',
          totalPages: 2,
          metadata: {},
          pages,
          mtime: 1,
        } as PecoDocument,
        currentPageIndex: 0,
        pageOrder: [0, 1],
      } as any)

      renderHook(() => useThumbnailWindow())
      await flushEffects()
      m.emit.mockClear()

      // pages の参照は変えず、無関係な currentPageIndex だけ変える
      // (キャッシュがあれば dirtyPagesSerialized の再走査自体は起きないが、
      //  emit されない挙動は変わらないことを検証する)
      act(() => {
        usePecoStore.setState({ currentPageIndex: 1 } as any)
      })
      await flushEffects()

      expect(dirtyEmitCount()).toBe(0)

      // 実際に dirty を変える (pages 参照を新規化) → キャッシュが正しく
      // 無効化され、正しい新しい値が emit されることを確認する
      const newPages = new Map(pages)
      newPages.set(0, makePage(0, [], true))
      act(() => {
        usePecoStore.setState({
          document: {
            filePath: 'cache.pdf',
            fileName: 'cache.pdf',
            totalPages: 2,
            metadata: {},
            pages: newPages,
            mtime: 1,
          } as PecoDocument,
        } as any)
      })
      await flushEffects()

      const dirtyEmits = m.emit.mock.calls.filter((c) => c[0] === 'thumbnail:dirty-update')
      expect(dirtyEmits.at(-1)?.[1]).toEqual({ dirtyPages: [0] })
    })

    it('pages Map 参照が同一のまま無関係な store 更新があっても rotation-update は増えず、実際に回転が変化した時は正しい値が emit される', async () => {
      const pages = new Map([
        [0, makePage(0, [], false, 0)],
        [1, makePage(1, [], false, 0)],
      ])
      usePecoStore.setState({
        document: {
          filePath: 'cache2.pdf',
          fileName: 'cache2.pdf',
          totalPages: 2,
          metadata: {},
          pages,
          mtime: 1,
        } as PecoDocument,
        currentPageIndex: 0,
        pageOrder: [0, 1],
      } as any)

      renderHook(() => useThumbnailWindow())
      await flushEffects()

      const baseline = m.emit.mock.calls.filter((c) => c[0] === 'thumbnail:rotation-update').length

      act(() => {
        usePecoStore.setState({ currentPageIndex: 1 } as any)
      })
      await flushEffects()

      expect(
        m.emit.mock.calls.filter((c) => c[0] === 'thumbnail:rotation-update').length
      ).toBe(baseline)

      const newPages = new Map(pages)
      newPages.set(1, makePage(1, [], false, 90))
      act(() => {
        usePecoStore.setState({
          document: {
            filePath: 'cache2.pdf',
            fileName: 'cache2.pdf',
            totalPages: 2,
            metadata: {},
            pages: newPages,
            mtime: 1,
          } as PecoDocument,
        } as any)
      })
      await flushEffects()

      const rotationEmits = m.emit.mock.calls.filter((c) => c[0] === 'thumbnail:rotation-update')
      expect(rotationEmits.at(-1)?.[1]).toEqual({ rotations: [0, 90] })
    })
  })
})
