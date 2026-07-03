import { describe, it, expect, vi, beforeAll } from 'vitest'

// pdfLoader.ts はモジュール読み込み時に window.fetch を asset.localhost 向けの
// Accept-Ranges 注入パッチでラップする (Tauri asset protocol が Range Request の
// レスポンスに Accept-Ranges ヘッダーを含めないため、pdfjs の Range 対応判定を
// 誤らせないための回避策)。この挙動を検証するには、pdfLoader インポート**前**に
// window.fetch を差し替えて「元の fetch」としてキャプチャさせる必要がある。
//
// 静的 import はファイル内の記述位置に関わらず ESM ホイスティングでモック定義の
// 直後（他の文より先）に評価されてしまうため、ここでは動的 import() を beforeAll 内で
// 使い、window.fetch 差し替え → pdfLoader ロードの順序を明示的に担保する。

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => path,
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  stat: vi.fn().mockResolvedValue({ mtime: Date.now() }),
}))

vi.mock('../../utils/bitmapCache', () => ({
  clearBitmapCache: vi.fn(),
}))

const origFetchMock = vi.fn()

beforeAll(async () => {
  window.fetch = origFetchMock as unknown as typeof fetch
  await import('../../utils/pdfLoader')
})

function makeResponse(status: number, headers: Record<string, string> = {}) {
  return new Response('body', { status, headers })
}

describe('pdfLoader: window.fetch patch (Tauri asset.localhost Accept-Ranges 注入)', () => {
  it('asset.localhost を含まない URL はそのまま元の fetch に委譲し、レスポンスも変形しない', async () => {
    const original = makeResponse(200)
    origFetchMock.mockResolvedValueOnce(original)

    const res = await window.fetch('https://example.com/data.json')

    expect(origFetchMock).toHaveBeenCalledWith('https://example.com/data.json', undefined)
    expect(res).toBe(original)
  })

  it('asset.localhost を含む URL (string) は accept-ranges ヘッダーが無ければ付与する', async () => {
    origFetchMock.mockResolvedValueOnce(makeResponse(206))

    const res = await window.fetch('http://asset.localhost/big.pdf')

    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.status).toBe(206)
  })

  it('asset.localhost かつ既に accept-ranges を持つレスポンスは上書きしない', async () => {
    origFetchMock.mockResolvedValueOnce(makeResponse(206, { 'accept-ranges': 'none' }))

    const res = await window.fetch('http://asset.localhost/big.pdf')

    expect(res.headers.get('accept-ranges')).toBe('none')
  })

  it('input が URL インスタンスでも asset.localhost 判定できる', async () => {
    origFetchMock.mockResolvedValueOnce(makeResponse(206))
    const url = new URL('http://asset.localhost/via-url-object.pdf')

    const res = await window.fetch(url)

    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(origFetchMock).toHaveBeenCalledWith(url, undefined)
  })

  it('input が Request 相当のオブジェクト (.url プロパティ) でも asset.localhost 判定できる', async () => {
    origFetchMock.mockResolvedValueOnce(makeResponse(206))
    const requestLike = { url: 'http://asset.localhost/via-request.pdf' } as Request

    const res = await window.fetch(requestLike)

    expect(res.headers.get('accept-ranges')).toBe('bytes')
  })
})
