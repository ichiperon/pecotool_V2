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

// 広域 npm test のフル並列時、pdfjs-dist を含む重い動的 import が既定 5s を
// 超えて flaky になる実績あり（単独実行では常に緑・2026-07-03 実測）。
describe('pdfLoader モジュール初期化: workerSrc が既に設定済みなら上書きしない', { timeout: 20_000 }, () => {
  it('GlobalWorkerOptions.workerSrc が既に truthy な場合、import 後も値が変わらない', async () => {
    await import('../../utils/pdfLoader')

    expect(GlobalWorkerOptions.workerSrc).toBe('https://already-configured.example/worker.js')
  })
})
