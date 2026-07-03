import { describe, it, expect, vi } from 'vitest'

// pdfLoader.ts はモジュール読み込み時に
// `if (typeof window !== 'undefined' && !pdfjsLib.GlobalWorkerOptions.workerSrc)` を
// チェックし、workerSrc が未設定の場合のみ自前の wrapper worker URL を注入する。
// 既存テスト (pdfLoader.test.ts 等) は workerSrc: '' (未設定) のケースしか通らないため、
// 「既に設定済みなら上書きしない」分岐はこのファイルで独立して検証する。

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: 'https://already-configured.example/worker.js' },
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

import { GlobalWorkerOptions } from 'pdfjs-dist'

describe('pdfLoader モジュール初期化: workerSrc が既に設定済みなら上書きしない', () => {
  it('GlobalWorkerOptions.workerSrc が既に truthy な場合、import 後も値が変わらない', async () => {
    await import('../../utils/pdfLoader')

    expect(GlobalWorkerOptions.workerSrc).toBe('https://already-configured.example/worker.js')
  })
})
