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
import { renderHook, act } from '@testing-library/react'

// ── hoisted mocks ──────────────────────────────────────────────
const m = vi.hoisted(() => {
  const listen = vi.fn(async (_eventName: string, _cb: any) => {
    return () => {}
  })
  const emit = vi.fn().mockResolvedValue(undefined)
  const getAllWindows = vi.fn().mockResolvedValue([])
  return { listen, emit, getAllWindows }
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

function makePage(pageIndex: number, blocks: TextBlock[], isDirty = false): PageData {
  return {
    pageIndex,
    width: 100,
    height: 100,
    textBlocks: blocks,
    isDirty,
    thumbnail: null,
  }
}

function makeDoc(pages: PageData[]): PecoDocument {
  return {
    filePath: 'test.pdf',
    fileName: 'test.pdf',
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

describe('useThumbnailWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    usePecoStore.setState({
      document: null,
      currentPageIndex: 0,
      selectedIds: new Set<string>(),
      undoStack: [],
      redoStack: [],
      isDirty: false,
    } as any)
  })

  afterEach(() => {
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
      await Promise.resolve()
      await Promise.resolve()

      const baselineDirtyEmits = dirtyEmitCount()

      // textBlocks だけ変化させる (dirty フラグは変えない) を 5 回繰り返す
      for (let i = 0; i < 5; i++) {
        const text = 'hello' + 'x'.repeat(i + 1)
        act(() => {
          usePecoStore.setState({
            document: makeDoc([makePage(0, [makeBlock('b1', text, 0)])]),
          } as any)
        })
        await Promise.resolve()
        await Promise.resolve()
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

      await Promise.resolve()
      await Promise.resolve()
      m.emit.mockClear()

      // ページを dirty にする
      act(() => {
        usePecoStore.setState({
          document: makeDoc([makePage(0, [makeBlock('b1', 'hello', 0)], true)]),
        } as any)
      })
      await Promise.resolve()
      await Promise.resolve()

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

      await Promise.resolve()
      await Promise.resolve()

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
      await Promise.resolve()
      await Promise.resolve()

      const dirtyEmits = m.emit.mock.calls.filter(
        (c) => c[0] === 'thumbnail:dirty-update'
      )
      expect(dirtyEmits.length).toBeGreaterThanOrEqual(1)
      expect(dirtyEmits.at(-1)?.[1]).toEqual({ dirtyPages: [0, 2] })
    })
  })
})
