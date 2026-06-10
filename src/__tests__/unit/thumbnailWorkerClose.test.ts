/**
 * thumbnail.worker.ts の CLOSE_PDF ハンドラ（PCT-073）をユニットテストする。
 *
 * worker モジュールは import 時に self.onmessage を登録し、モジュールレベルの
 * 状態（pdfDoc / currentLoadingTask / loadPromise）を持つ。テストごとに
 * vi.resetModules() + 動的 import で状態を分離する。
 *
 * jsdom では self === window のため、worker が登録する onmessage は
 * globalThis.onmessage から取得でき、self.postMessage は記録用スタブに
 * 差し替えて応答メッセージを観測する。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const getDocumentMock = vi.fn()

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (...args: unknown[]) => getDocumentMock(...args),
}))

type WorkerMessage = { type: string; requestId?: number; [key: string]: unknown }
type OnMessage = (e: MessageEvent<unknown>) => void

let originalPostMessage: unknown
let originalOnMessage: unknown

/** worker モジュールを新規ロードし、onmessage と post 記録を返す */
async function importWorker(): Promise<{ onmessage: OnMessage; posted: WorkerMessage[] }> {
  vi.resetModules()
  const posted: WorkerMessage[] = []
  ;(globalThis as Record<string, unknown>).postMessage = (msg: unknown) => {
    posted.push(msg as WorkerMessage)
  }
  await import('../../utils/thumbnail.worker')
  const onmessage = (globalThis as { onmessage?: OnMessage | null }).onmessage
  if (!onmessage) throw new Error('thumbnail.worker did not register self.onmessage')
  return { onmessage, posted }
}

function send(onmessage: OnMessage, data: unknown) {
  onmessage({ data } as MessageEvent<unknown>)
}

beforeEach(() => {
  vi.clearAllMocks()
  originalPostMessage = (globalThis as Record<string, unknown>).postMessage
  originalOnMessage = (globalThis as Record<string, unknown>).onmessage
})

afterEach(() => {
  ;(globalThis as Record<string, unknown>).postMessage = originalPostMessage
  ;(globalThis as Record<string, unknown>).onmessage = originalOnMessage
})

describe('thumbnail.worker CLOSE_PDF (PCT-073)', () => {
  it('ロード完了後の CLOSE_PDF で pdfDoc.destroy() が呼ばれる', async () => {
    const docDestroy = vi.fn().mockResolvedValue(undefined)
    const taskDestroy = vi.fn().mockResolvedValue(undefined)
    const doc = { numPages: 3, destroy: docDestroy }
    getDocumentMock.mockReturnValue({ promise: Promise.resolve(doc), destroy: taskDestroy })

    const { onmessage, posted } = await importWorker()
    send(onmessage, { type: 'LOAD_PDF', url: 'http://localhost/test.pdf', requestId: 1 })

    await vi.waitFor(() => {
      expect(posted.some((m) => m.type === 'LOAD_COMPLETE' && m.requestId === 1)).toBe(true)
    })
    expect(docDestroy).not.toHaveBeenCalled()

    send(onmessage, { type: 'CLOSE_PDF' })

    await vi.waitFor(() => {
      expect(docDestroy).toHaveBeenCalledTimes(1)
    })
  })

  it('ロード進行中の CLOSE_PDF で loadingTask.destroy() が呼ばれる（未解決ロードの中断）', async () => {
    const taskDestroy = vi.fn().mockResolvedValue(undefined)
    getDocumentMock.mockReturnValue({
      promise: new Promise(() => {}), // 永遠に未解決（大型 PDF ロード中を模擬）
      destroy: taskDestroy,
    })

    const { onmessage } = await importWorker()
    send(onmessage, { type: 'LOAD_PDF', url: 'http://localhost/huge.pdf', requestId: 1 })

    // handleLoadPdf は冒頭の releaseCurrentPdf() を await してから getDocument
    // するため、currentLoadingTask 設定済みになるまで待つ
    await vi.waitFor(() => {
      expect(getDocumentMock).toHaveBeenCalledTimes(1)
    })
    expect(taskDestroy).not.toHaveBeenCalled()

    send(onmessage, { type: 'CLOSE_PDF' })

    await vi.waitFor(() => {
      expect(taskDestroy).toHaveBeenCalledTimes(1)
    })
  })

  it('CLOSE_PDF 後の GENERATE_THUMBNAIL は THUMBNAIL_ERROR を返す（pdfDoc 解放済み）', async () => {
    const getPage = vi.fn()
    const doc = { numPages: 3, destroy: vi.fn().mockResolvedValue(undefined), getPage }
    getDocumentMock.mockReturnValue({
      promise: Promise.resolve(doc),
      destroy: vi.fn().mockResolvedValue(undefined),
    })

    const { onmessage, posted } = await importWorker()
    send(onmessage, { type: 'LOAD_PDF', url: 'http://localhost/test.pdf', requestId: 1 })
    await vi.waitFor(() => {
      expect(posted.some((m) => m.type === 'LOAD_COMPLETE')).toBe(true)
    })

    send(onmessage, { type: 'CLOSE_PDF' })
    await vi.waitFor(() => {
      expect(doc.destroy).toHaveBeenCalled()
    })

    send(onmessage, { type: 'GENERATE_THUMBNAIL', pageIndex: 0, requestId: 9 })
    await vi.waitFor(() => {
      expect(posted.some((m) => m.type === 'THUMBNAIL_ERROR' && m.requestId === 9)).toBe(true)
    })
    // 解放済み doc に対して render が走っていないこと
    expect(getPage).not.toHaveBeenCalled()
  })

  it('未ロード状態の CLOSE_PDF は no-op（例外も応答もなし）', async () => {
    const { onmessage, posted } = await importWorker()

    expect(() => send(onmessage, { type: 'CLOSE_PDF' })).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    expect(posted).toHaveLength(0)
    expect(getDocumentMock).not.toHaveBeenCalled()
  })

  it('CLOSE_PDF 後の LOAD_PDF は新しいドキュメントを正常にロードできる', async () => {
    const doc1 = { numPages: 3, destroy: vi.fn().mockResolvedValue(undefined) }
    const doc2 = { numPages: 7, destroy: vi.fn().mockResolvedValue(undefined) }
    getDocumentMock
      .mockReturnValueOnce({ promise: Promise.resolve(doc1), destroy: vi.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({ promise: Promise.resolve(doc2), destroy: vi.fn().mockResolvedValue(undefined) })

    const { onmessage, posted } = await importWorker()
    send(onmessage, { type: 'LOAD_PDF', url: 'http://localhost/a.pdf', requestId: 1 })
    await vi.waitFor(() => {
      expect(posted.some((m) => m.type === 'LOAD_COMPLETE' && m.requestId === 1)).toBe(true)
    })

    send(onmessage, { type: 'CLOSE_PDF' })
    await vi.waitFor(() => {
      expect(doc1.destroy).toHaveBeenCalledTimes(1)
    })

    send(onmessage, { type: 'LOAD_PDF', url: 'http://localhost/b.pdf', requestId: 2 })
    await vi.waitFor(() => {
      expect(posted.some((m) => m.type === 'LOAD_COMPLETE' && m.requestId === 2 && m.numPages === 7)).toBe(true)
    })
    // CLOSE_PDF で解放済みのため LOAD_PDF 側で doc1 を二重 destroy しない
    expect(doc1.destroy).toHaveBeenCalledTimes(1)
  })
})
