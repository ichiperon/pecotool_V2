import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TextPreviewWindow } from '../../components/TextPreviewWindow'

// ── Tauri API モック ───────────────────────────────────────────

const mockListen = vi.fn()
const mockEmit = vi.fn().mockResolvedValue(undefined)

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: any[]) => mockListen(...args),
  emit: (...args: any[]) => mockEmit(...args),
}))

const mockHide = vi.fn()
const mockGetCurrentWindow = vi.fn()

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => mockGetCurrentWindow(),
}))

vi.mock('lucide-react', () => ({
  Copy: () => null,
}))

// ── setup ──────────────────────────────────────────────────────

afterEach(() => cleanup())

beforeEach(() => {
  vi.clearAllMocks()
  mockHide.mockResolvedValue(undefined)
  mockGetCurrentWindow.mockReturnValue({
    onCloseRequested: vi.fn().mockResolvedValue(() => {}),
    hide: mockHide,
  })
})

// ── テスト ────────────────────────────────────────────────────

describe('TextPreviewWindow', () => {

  describe('C-PW-01: preview-update イベントで描画更新', () => {
    it('preview-update イベントを受け取ったテキストが textarea に表示', async () => {
      let previewCallback: ((event: any) => void) | undefined

      mockListen.mockImplementation(async (eventName: string, cb: any) => {
        if (eventName === 'preview-update') {
          previewCallback = cb
        }
        return () => {}
      })

      render(<TextPreviewWindow />)

      await waitFor(() => expect(previewCallback).toBeDefined())

      act(() => {
        previewCallback!({ payload: 'テスト テキスト 表示' })
      })

      const textarea = screen.getByRole('textbox')
      expect((textarea as HTMLTextAreaElement).value).toBe('テスト テキスト 表示')
    })

    it('複数回イベントを受け取ると最新のテキストが表示', async () => {
      let previewCallback: ((event: any) => void) | undefined

      mockListen.mockImplementation(async (eventName: string, cb: any) => {
        if (eventName === 'preview-update') previewCallback = cb
        return () => {}
      })

      render(<TextPreviewWindow />)
      await waitFor(() => expect(previewCallback).toBeDefined())

      act(() => { previewCallback!({ payload: '最初のテキスト' }) })
      act(() => { previewCallback!({ payload: '最新のテキスト' }) })

      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('最新のテキスト')
    })
  })

  describe('C-PW-02: 全てコピーボタン', () => {
    it('クリック → navigator.clipboard.writeText が呼ばれる', async () => {
      let previewCallback: ((event: any) => void) | undefined

      mockListen.mockImplementation(async (eventName: string, cb: any) => {
        if (eventName === 'preview-update') previewCallback = cb
        return () => {}
      })

      const mockWriteText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: mockWriteText },
        configurable: true,
      })

      render(<TextPreviewWindow />)
      await waitFor(() => expect(previewCallback).toBeDefined())

      act(() => { previewCallback!({ payload: 'コピーするテキスト' }) })

      const copyButton = screen.getByRole('button')
      fireEvent.click(copyButton)

      expect(mockWriteText).toHaveBeenCalledWith('コピーするテキスト')
    })
  })

  describe('C-PW-03: 閉じるボタン（onCloseRequested）', () => {
    it('onCloseRequested コールバック → event.preventDefault と win.hide が呼ばれる', async () => {
      let closeCallback: ((event: any) => void) | undefined

      mockListen.mockResolvedValue(() => {})
      mockGetCurrentWindow.mockReturnValue({
        onCloseRequested: vi.fn().mockImplementation(async (cb: any) => {
          closeCallback = cb
          return () => {}
        }),
        hide: mockHide,
      })

      render(<TextPreviewWindow />)
      await waitFor(() => expect(closeCallback).toBeDefined())

      const mockEvent = { preventDefault: vi.fn() }
      closeCallback!(mockEvent)

      expect(mockEvent.preventDefault).toHaveBeenCalled()
      expect(mockHide).toHaveBeenCalled()
    })
  })

  describe('C-PW-04: コピーボタンが2秒後にリセット', () => {
    it('コピー後 2000ms 経過 → ボタンテキストが "全てコピー" に戻る', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })

      let previewCallback: ((event: any) => void) | undefined
      mockListen.mockImplementation(async (eventName: string, cb: any) => {
        if (eventName === 'preview-update') previewCallback = cb
        return () => {}
      })

      const mockWriteText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: mockWriteText },
        configurable: true,
      })

      render(<TextPreviewWindow />)
      await waitFor(() => expect(previewCallback).toBeDefined())

      act(() => { previewCallback!({ payload: 'テスト' }) })

      const copyButton = screen.getByRole('button')

      // click and resolve clipboard promise
      await act(async () => {
        fireEvent.click(copyButton)
        await Promise.resolve()
      })

      expect(screen.getByText('コピーしました！')).toBeTruthy()

      // 2秒経過
      act(() => { vi.advanceTimersByTime(2000) })

      expect(screen.getByText('全てコピー')).toBeTruthy()

      vi.useRealTimers()
    })
  })

  describe('C-PW-06: マウント時に request-preview を emit', () => {
    it('マウント → emit("request-preview") が呼ばれる', async () => {
      mockListen.mockImplementation(async (_eventName: string, _cb: any) => {
        return () => {}
      })

      render(<TextPreviewWindow />)

      await waitFor(() => {
        expect(mockEmit).toHaveBeenCalledWith('request-preview')
      })
    })
  })

  describe('C-PW-07: アンマウント時に unlisten が呼ばれる', () => {
    it('unmount → listen で返された unlisten 関数がすべて呼ばれる', async () => {
      const unlistenPreview = vi.fn()
      const unlistenClose = vi.fn()

      mockListen.mockImplementation(async (eventName: string, _cb: any) => {
        if (eventName === 'preview-update') return unlistenPreview
        return () => {}
      })

      mockGetCurrentWindow.mockReturnValue({
        onCloseRequested: vi.fn().mockImplementation(async (_cb: any) => {
          return unlistenClose
        }),
        hide: mockHide,
      })

      const { unmount } = render(<TextPreviewWindow />)

      // setup が完了するのを待つ
      await waitFor(() => {
        expect(mockEmit).toHaveBeenCalledWith('request-preview')
      })

      unmount()

      expect(unlistenPreview).toHaveBeenCalled()
      expect(unlistenClose).toHaveBeenCalled()
    })
  })

})
