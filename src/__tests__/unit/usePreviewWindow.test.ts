/**
 * issue #17 回帰テスト
 *
 * 修正前: usePreviewWindow の useEffect が依存配列に previewText を持っていたため、
 *         OCR 編集 1 文字ごとに `unlistenFn() → listen('request-preview') →
 *         listen('preview-hidden')` の Tauri IPC 4 ラウンドトリップが発火していた。
 * 修正後: listener 登録 useEffect は依存配列 [] で 1 回だけ走り、listener 内では
 *         previewTextRef.current から最新値を読む。
 *
 * 本テストは「previewText が複数回変化しても listen() の呼び出し回数が
 * 初回マウント時のぶん (request-preview / preview-hidden の 2 回) から増えないこと」を検証する。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

// ── hoisted mocks ──────────────────────────────────────────────
const m = vi.hoisted(() => {
  const unlistenRequest = vi.fn()
  const unlistenHidden = vi.fn()
  const listen = vi.fn(async (eventName: string, _cb: any) => {
    if (eventName === 'request-preview') return unlistenRequest
    if (eventName === 'preview-hidden') return unlistenHidden
    return () => {}
  })
  const emit = vi.fn().mockResolvedValue(undefined)
  const getAllWindows = vi.fn().mockResolvedValue([])
  return { unlistenRequest, unlistenHidden, listen, emit, getAllWindows }
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

import { usePreviewWindow } from '../../hooks/usePreviewWindow'
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

function makePage(pageIndex: number, blocks: TextBlock[]): PageData {
  return {
    pageIndex,
    width: 100,
    height: 100,
    textBlocks: blocks,
    isDirty: false,
    thumbnail: null,
  }
}

function makeDocWithPage(page: PageData): PecoDocument {
  return {
    filePath: 'test.pdf',
    fileName: 'test.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map<number, PageData>([[page.pageIndex, page]]),
    mtime: 1234,
  }
}

// ── テスト ─────────────────────────────────────────────────────

describe('usePreviewWindow', () => {
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

  describe('issue #17 回帰: previewText 変更で listener が再登録されない', () => {
    it('previewText が複数回変化しても listen() は初回マウント時の 2 回 (request-preview / preview-hidden) のみ', async () => {
      // 初期ページを 1 ブロックで投入
      const initialBlocks = [makeBlock('b1', 'hello', 0)]
      usePecoStore.setState({
        document: makeDocWithPage(makePage(0, initialBlocks)),
        currentPageIndex: 0,
      } as any)

      const { unmount } = renderHook(() => usePreviewWindow())

      // listener setup (useEffect 内の async) 完了を待つ
      await waitFor(() => {
        expect(m.listen).toHaveBeenCalledWith('request-preview', expect.any(Function))
        expect(m.listen).toHaveBeenCalledWith('preview-hidden', expect.any(Function))
      })

      const listenCallsAfterMount = m.listen.mock.calls.length
      // 初回マウントで request-preview と preview-hidden の 2 回登録される
      expect(listenCallsAfterMount).toBe(2)

      // OCR 編集 1 文字ごとに textBlocks が変わるのを模擬: 5 回 setState
      for (let i = 0; i < 5; i++) {
        const text = 'hello' + 'x'.repeat(i + 1)
        act(() => {
          usePecoStore.setState({
            document: makeDocWithPage(makePage(0, [makeBlock('b1', text, 0)])),
          } as any)
        })
        // useEffect の microtask を進める
        await Promise.resolve()
        await Promise.resolve()
      }

      // previewText 変化で listener 再登録が起きていないこと（呼び出し回数増加なし）
      expect(m.listen.mock.calls.length).toBe(listenCallsAfterMount)
      // unlisten も再登録ぶんは呼ばれていないこと
      expect(m.unlistenRequest).not.toHaveBeenCalled()
      expect(m.unlistenHidden).not.toHaveBeenCalled()

      unmount()

      // アンマウントで unlisten が 1 回ずつ呼ばれる
      await waitFor(() => {
        expect(m.unlistenRequest).toHaveBeenCalledTimes(1)
        expect(m.unlistenHidden).toHaveBeenCalledTimes(1)
      })
    })

    it('request-preview ハンドラ発火時は最新の previewText が emit される (ref から読む)', async () => {
      let requestPreviewCb: (() => void) | undefined
      m.listen.mockImplementation(async (eventName: string, cb: any) => {
        if (eventName === 'request-preview') {
          requestPreviewCb = cb
          return m.unlistenRequest
        }
        if (eventName === 'preview-hidden') return m.unlistenHidden
        return () => {}
      })

      // 初期テキスト
      usePecoStore.setState({
        document: makeDocWithPage(makePage(0, [makeBlock('b1', 'first', 0)])),
        currentPageIndex: 0,
      } as any)

      renderHook(() => usePreviewWindow())
      await waitFor(() => expect(requestPreviewCb).toBeDefined())

      // テキスト更新
      act(() => {
        usePecoStore.setState({
          document: makeDocWithPage(makePage(0, [makeBlock('b1', 'updated', 0)])),
        } as any)
      })
      await Promise.resolve()
      await Promise.resolve()

      // emit 呼び出し履歴をリセットしてから request-preview を発火
      m.emit.mockClear()
      requestPreviewCb!()

      // ref 経由で最新値 ('updated') が emit されること
      expect(m.emit).toHaveBeenCalledWith('preview-update', 'updated')
    })
  })
})
