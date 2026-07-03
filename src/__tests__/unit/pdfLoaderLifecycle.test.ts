import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getDocument } from 'pdfjs-dist'

// #409/#410 是正の流儀を踏襲: try/catch で reject も合格扱いにする vacuous なテストは書かない。
// graceful 挙動は「reject しないこと」「特定のフィールドが正しく設定されること」を明示的にアサートする。

// vi.mock ファクトリは静的にホイストされるため、参照する変数は vi.hoisted() で
// 定義する必要がある（"mock" プレフィックス命名規約に頼らず明示的に行う）。
const { pdfWorkerCtorMock, convertFileSrcMock, statMock } = vi.hoisted(() => ({
  pdfWorkerCtorMock: vi.fn(),
  convertFileSrcMock: vi.fn((path: string) => path),
  statMock: vi.fn(),
}))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
  PDFWorker: pdfWorkerCtorMock,
}))

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => convertFileSrcMock(path),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  stat: (...args: unknown[]) => statMock(...args),
}))

vi.mock('../../utils/bitmapCache', () => ({
  clearBitmapCache: vi.fn(),
}))

import {
  loadPDF,
  openPDF,
  openFreshPdfDoc,
  getSharedPdfProxy,
  getCachedPageProxy,
  destroySharedPdfProxy,
} from '../../utils/pdfLoader'

// ── ヘルパー ──────────────────────────────────────────────────

function makeFakeDocProxy(numPages = 1, overrides: Record<string, unknown> = {}) {
  return {
    numPages,
    destroy: vi.fn(),
    getMetadata: vi.fn().mockResolvedValue({ info: {} }),
    getPage: vi.fn().mockResolvedValue({ cleanup: vi.fn() }),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  convertFileSrcMock.mockImplementation((path: string) => path)
  statMock.mockResolvedValue({ mtime: new Date('2024-01-01T00:00:00Z') })
  destroySharedPdfProxy()
})

// ── loadPDF: 正常系 ───────────────────────────────────────────

describe('loadPDF: 正常ロード', () => {
  it('PecoDocument を構築し totalPages/fileName/pages/mtime/metadata を設定する', async () => {
    const fakePdf = makeFakeDocProxy(3, {
      getMetadata: vi.fn().mockResolvedValue({ info: { Title: 'My Title', Author: 'Author X' } }),
    })
    ;(getDocument as ReturnType<typeof vi.fn>).mockReturnValue({ promise: Promise.resolve(fakePdf), destroy: vi.fn() })

    const doc = await loadPDF('C:\\docs\\sample.pdf')

    expect(doc.totalPages).toBe(3)
    expect(doc.fileName).toBe('sample.pdf')
    expect(doc.pages).toBeInstanceOf(Map)
    expect(doc.mtime).toBe(new Date('2024-01-01T00:00:00Z').getTime())

    // getMetadata は非同期（ブロックしない）なのでマイクロタスクを掃く
    await new Promise((r) => setTimeout(r, 0))
    expect(doc.metadata.title).toBe('My Title')
    expect(doc.metadata.author).toBe('Author X')
  })

  it('パスがセパレータで終わる場合は fileName が document.pdf にフォールバックする', async () => {
    const fakePdf = makeFakeDocProxy(1)
    ;(getDocument as ReturnType<typeof vi.fn>).mockReturnValue({ promise: Promise.resolve(fakePdf), destroy: vi.fn() })

    const doc = await loadPDF('C:\\docs\\')
    expect(doc.fileName).toBe('document.pdf')
  })

  it('convertFileSrc が asset.localhost で始まる URL を返したら http:// を付与する', async () => {
    convertFileSrcMock.mockReturnValue('asset.localhost/some/path.pdf')
    const fakePdf = makeFakeDocProxy(1)
    ;(getDocument as ReturnType<typeof vi.fn>).mockReturnValue({ promise: Promise.resolve(fakePdf), destroy: vi.fn() })

    await loadPDF('whatever.pdf')

    expect(getDocument).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://asset.localhost/some/path.pdf' }),
    )
  })

  it('getMetadata が失敗しても loadPDF 自体は成功し metadata は undefined のまま', async () => {
    const fakePdf = makeFakeDocProxy(1, { getMetadata: vi.fn().mockRejectedValue(new Error('meta fail')) })
    ;(getDocument as ReturnType<typeof vi.fn>).mockReturnValue({ promise: Promise.resolve(fakePdf), destroy: vi.fn() })

    const doc = await loadPDF('meta-fail.pdf')
    await new Promise((r) => setTimeout(r, 0))

    expect(doc.metadata.title).toBeUndefined()
    expect(doc.metadata.author).toBeUndefined()
  })

  it('metadata.info.Title/Author が非文字列のとき undefined を設定する', async () => {
    const fakePdf = makeFakeDocProxy(1, {
      getMetadata: vi.fn().mockResolvedValue({ info: { Title: 123, Author: null } }),
    })
    ;(getDocument as ReturnType<typeof vi.fn>).mockReturnValue({ promise: Promise.resolve(fakePdf), destroy: vi.fn() })

    const doc = await loadPDF('non-string-meta.pdf')
    await new Promise((r) => setTimeout(r, 0))

    expect(doc.metadata.title).toBeUndefined()
    expect(doc.metadata.author).toBeUndefined()
  })

  it('メタデータ取得中に別ファイルへ切り替わったら古いドキュメントへの書き込みをスキップする', async () => {
    let resolveMeta!: (v: unknown) => void
    const metaPromise = new Promise((res) => { resolveMeta = res })
    const fakePdf1 = makeFakeDocProxy(1, { getMetadata: vi.fn().mockReturnValue(metaPromise) })
    const fakePdf2 = makeFakeDocProxy(1)

    ;(getDocument as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ promise: Promise.resolve(fakePdf1), destroy: vi.fn() })
      .mockReturnValueOnce({ promise: Promise.resolve(fakePdf2), destroy: vi.fn() })

    const doc1 = await loadPDF('first.pdf')
    // メタデータ解決前に別ファイルへ切り替える
    const doc2Promise = loadPDF('second.pdf')
    resolveMeta({ info: { Title: 'Stale Title' } })
    await doc2Promise
    await new Promise((r) => setTimeout(r, 0))

    // globalSharedPdfProxy が既に second.pdf を指しているため first.pdf の doc1 には書き込まれない
    expect(doc1.metadata.title).toBeUndefined()
  })

  it('mtime が number の場合はそのまま採用する', async () => {
    statMock.mockResolvedValue({ mtime: 1700000000000 })
    const fakePdf = makeFakeDocProxy(1)
    ;(getDocument as ReturnType<typeof vi.fn>).mockReturnValue({ promise: Promise.resolve(fakePdf), destroy: vi.fn() })

    const doc = await loadPDF('num-mtime.pdf')
    expect(doc.mtime).toBe(1700000000000)
  })

  it('mtime が null の場合は Date.now() にフォールバックする', async () => {
    statMock.mockResolvedValue({ mtime: null })
    const fakePdf = makeFakeDocProxy(1)
    ;(getDocument as ReturnType<typeof vi.fn>).mockReturnValue({ promise: Promise.resolve(fakePdf), destroy: vi.fn() })

    const before = Date.now()
    const doc = await loadPDF('null-mtime.pdf')
    const after = Date.now()

    expect(doc.mtime).toBeGreaterThanOrEqual(before)
    expect(doc.mtime).toBeLessThanOrEqual(after)
  })

  it('stat() が失敗しても loadPDF は成功し mtime は Date.now() にフォールバックする', async () => {
    statMock.mockRejectedValue(new Error('stat failed'))
    const fakePdf = makeFakeDocProxy(1)
    ;(getDocument as ReturnType<typeof vi.fn>).mockReturnValue({ promise: Promise.resolve(fakePdf), destroy: vi.fn() })

    const before = Date.now()
    const doc = await loadPDF('stat-fail.pdf')

    expect(doc.mtime).toBeGreaterThanOrEqual(before)
  })
})

// ── loadPDF: エラー・キャンセル分岐 ───────────────────────────

describe('loadPDF: エラー・キャンセル分岐', () => {
  it('通常のエラーで reject されたら loadId 変化なしのまま同じエラーで reject する', async () => {
    const originalError = new Error('boom')
    ;(getDocument as ReturnType<typeof vi.fn>).mockReturnValue({ promise: Promise.reject(originalError), destroy: vi.fn() })

    await expect(loadPDF('bad.pdf')).rejects.toBe(originalError)
  })

  it('promise 解決後にファイルが切り替わっていたら pdf を破棄し cancelled エラーを投げる', async () => {
    let resolvePdf!: (v: unknown) => void
    const pdfPromise = new Promise((res) => { resolvePdf = res })
    const fakePdf = makeFakeDocProxy(1)

    ;(getDocument as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ promise: pdfPromise, destroy: vi.fn() })
      .mockReturnValueOnce({ promise: new Promise(() => {}), destroy: vi.fn() })

    const firstLoad = loadPDF('first.pdf')
    // 1つ目の promise が解決する前に、2つ目のロードを開始して globalLoadId を進める
    void getSharedPdfProxy('second.pdf')
    resolvePdf(fakePdf)

    await expect(firstLoad).rejects.toThrow('[loadPDF] cancelled: newer file load started')
    expect(fakePdf.destroy).toHaveBeenCalledTimes(1)
  })
})

// ── openPDF / openFreshPdfDoc ─────────────────────────────────

describe('openPDF', () => {
  it('convertFileSrc の URL で pdf ドキュメントを取得する', async () => {
    const fakePdf = makeFakeDocProxy(2)
    ;(getDocument as ReturnType<typeof vi.fn>).mockReturnValue({ promise: Promise.resolve(fakePdf) })
    convertFileSrcMock.mockReturnValue('http://asset.localhost/x.pdf')

    const pdf = await openPDF('x.pdf')

    expect(pdf).toBe(fakePdf)
    expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://asset.localhost/x.pdf' }))
  })
})

describe('openFreshPdfDoc', () => {
  it('asset.localhost で始まる URL には http:// を付与する', async () => {
    convertFileSrcMock.mockReturnValue('asset.localhost/fresh.pdf')
    const fakePdf = makeFakeDocProxy(1)
    ;(getDocument as ReturnType<typeof vi.fn>).mockReturnValue({ promise: Promise.resolve(fakePdf) })

    await openFreshPdfDoc('fresh.pdf')

    expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://asset.localhost/fresh.pdf' }))
  })

  it('既に http(s):// が付いた URL はそのまま使う', async () => {
    convertFileSrcMock.mockReturnValue('https://asset.localhost/fresh2.pdf')
    const fakePdf = makeFakeDocProxy(1)
    ;(getDocument as ReturnType<typeof vi.fn>).mockReturnValue({ promise: Promise.resolve(fakePdf) })

    await openFreshPdfDoc('fresh2.pdf')

    expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://asset.localhost/fresh2.pdf' }))
  })

  it('OCR 用の独立ドキュメントは共有 proxy とは別インスタンスになる', async () => {
    const sharedPdf = makeFakeDocProxy(1)
    const freshPdf = makeFakeDocProxy(1)
    ;(getDocument as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ promise: Promise.resolve(sharedPdf), destroy: vi.fn() })
      .mockReturnValueOnce({ promise: Promise.resolve(freshPdf) })

    await getSharedPdfProxy('shared.pdf')
    const fresh = await openFreshPdfDoc('shared.pdf')

    expect(fresh).toBe(freshPdf)
    expect(fresh).not.toBe(sharedPdf)
  })
})

// ── getSharedPdfProxy ──────────────────────────────────────────

describe('getSharedPdfProxy', () => {
  it('asset.localhost で始まる URL に http:// を付与する', async () => {
    convertFileSrcMock.mockReturnValue('asset.localhost/shared.pdf')
    const fakePdf = makeFakeDocProxy(1)
    ;(getDocument as ReturnType<typeof vi.fn>).mockReturnValue({ promise: Promise.resolve(fakePdf), destroy: vi.fn() })

    await getSharedPdfProxy('shared-asset.pdf')

    expect(getDocument).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://asset.localhost/shared.pdf' }),
    )
  })
})

// ── getCachedPageProxy ─────────────────────────────────────────

describe('getCachedPageProxy', () => {
  it('2回目アクセスはキャッシュヒットし getPage を再呼び出ししない', async () => {
    const page = { cleanup: vi.fn() }
    const fakePdf = makeFakeDocProxy(1, { getPage: vi.fn().mockResolvedValue(page) })
    ;(getDocument as ReturnType<typeof vi.fn>).mockReturnValue({ promise: Promise.resolve(fakePdf), destroy: vi.fn() })
    await getSharedPdfProxy('cache.pdf')

    const first = await getCachedPageProxy('cache.pdf', 0)
    const second = await getCachedPageProxy('cache.pdf', 0)

    expect(first).toBe(page)
    expect(second).toBe(page)
    expect(fakePdf.getPage).toHaveBeenCalledTimes(1)
  })

  it('LRU 上限 (30) を超えると最も古いページを evict して cleanup() を呼ぶ', async () => {
    const cleanupCalls: number[] = []
    const fakePdf = makeFakeDocProxy(40, {
      getPage: vi.fn().mockImplementation((pageNumber: number) => Promise.resolve({
        cleanup: vi.fn(() => cleanupCalls.push(pageNumber)),
      })),
    })
    ;(getDocument as ReturnType<typeof vi.fn>).mockReturnValue({ promise: Promise.resolve(fakePdf), destroy: vi.fn() })
    await getSharedPdfProxy('lru.pdf')

    // 上限 30 を 1 超える 31 ページ分アクセスして eviction をトリガーする
    for (let i = 0; i < 31; i++) {
      await getCachedPageProxy('lru.pdf', i)
    }

    // 最初にアクセスしたページ (pageIndex 0 → getPage(1)) が evict され cleanup() が呼ばれている
    expect(cleanupCalls).toContain(1)
    // 直近にアクセスしたページは再取得なしでキャッシュヒットする
    fakePdf.getPage.mockClear()
    await getCachedPageProxy('lru.pdf', 30)
    expect(fakePdf.getPage).not.toHaveBeenCalled()
  })

  it('取得中にファイルが切り替わったら cancelled エラーで reject する', async () => {
    let resolveDoc!: (v: unknown) => void
    const docPromise = new Promise((res) => { resolveDoc = res })
    const fakePdf1 = makeFakeDocProxy(1)
    const fakePdf2 = makeFakeDocProxy(1)

    ;(getDocument as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ promise: docPromise, destroy: vi.fn() })
      .mockReturnValueOnce({ promise: Promise.resolve(fakePdf2), destroy: vi.fn() })

    const pagePromise = getCachedPageProxy('switch.pdf', 0)
    // 取得中に別ファイルへ切り替える
    void getSharedPdfProxy('other.pdf')
    resolveDoc(fakePdf1)

    await expect(pagePromise).rejects.toThrow(/cancelled: file switched/)
  })
})

// ── getSharedPdfWorker (getDocumentTask 経由の間接検証) ────────

describe('getSharedPdfWorker: worker シングルトンの再利用', () => {
  it('別ファイルへの getSharedPdfProxy 呼び出し間で PDFWorker を再構築しない', async () => {
    const fakePdf = makeFakeDocProxy(1)
    ;(getDocument as ReturnType<typeof vi.fn>).mockReturnValue({ promise: Promise.resolve(fakePdf), destroy: vi.fn() })

    await getSharedPdfProxy('worker-a.pdf')
    const callsAfterFirst = pdfWorkerCtorMock.mock.calls.length

    await getSharedPdfProxy('worker-b.pdf')
    expect(pdfWorkerCtorMock.mock.calls.length).toBe(callsAfterFirst)
  })
})

// ── destroySharedPdfProxy: エラー分岐 (PCT-072 追補) ───────────

describe('destroySharedPdfProxy: task.destroy() のエラー分岐', () => {
  it('task.destroy() が返す Promise が reject しても warn ログを出すだけで例外を投げない', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const taskDestroy = vi.fn().mockReturnValue(Promise.reject(new Error('destroy promise rejected')))
    ;(getDocument as ReturnType<typeof vi.fn>).mockReturnValue({
      promise: Promise.resolve(makeFakeDocProxy(1)),
      destroy: taskDestroy,
    })
    await getSharedPdfProxy('reject-destroy.pdf')

    expect(() => destroySharedPdfProxy()).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))

    expect(taskDestroy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('loadingTask.destroy() 失敗'),
      expect.any(Error),
    )
    warnSpy.mockRestore()
  })

  it('task.destroy() が同期的に throw しても catch されて warn ログを出すだけで例外を投げない', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const taskDestroy = vi.fn(() => { throw new Error('sync destroy boom') })
    ;(getDocument as ReturnType<typeof vi.fn>).mockReturnValue({
      promise: Promise.resolve(makeFakeDocProxy(1)),
      destroy: taskDestroy,
    })
    await getSharedPdfProxy('sync-throw-destroy.pdf')

    expect(() => destroySharedPdfProxy()).not.toThrow()

    expect(taskDestroy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('loadingTask.destroy() 失敗'),
      expect.any(Error),
    )
    warnSpy.mockRestore()
  })
})

describe('destroySharedPdfProxy: legacy 経路 (task.destroy を持たない) のエラー分岐', () => {
  it('PDFDocumentProxy.destroy() が throw しても warn ログを出すだけで例外を投げない', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pdfDestroy = vi.fn(() => { throw new Error('proxy destroy boom') })
    ;(getDocument as ReturnType<typeof vi.fn>).mockReturnValue({
      // task に destroy() が無い = legacy 経路 (テストモック等の後方互換パス)
      promise: Promise.resolve({ destroy: pdfDestroy, getPage: vi.fn() }),
    })
    await getSharedPdfProxy('legacy-throw.pdf')

    destroySharedPdfProxy()
    await new Promise((r) => setTimeout(r, 0))

    expect(pdfDestroy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('PDFDocumentProxy.destroy() 失敗'),
      expect.any(Error),
    )
    warnSpy.mockRestore()
  })

  it('proxy.promise 自体が reject したら warn ログを出す', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(getDocument as ReturnType<typeof vi.fn>).mockReturnValue({
      // destroy を持たない task = legacy 経路
      promise: Promise.reject(new Error('resolve failed')),
    })
    await getSharedPdfProxy('legacy-reject.pdf').catch(() => {})

    destroySharedPdfProxy()
    await new Promise((r) => setTimeout(r, 0))

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('destroySharedPdfProxy: Promiseエラー'),
      expect.any(Error),
    )
    warnSpy.mockRestore()
  })
})
