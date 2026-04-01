import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TextPreviewWindow } from '../components/TextPreviewWindow'

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

})
