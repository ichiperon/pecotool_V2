/**
 * vitest global setup
 * jsdom は canvas を実装しないため、pdfSaver が使う最小限のスタブを用意する。
 */
import { vi } from 'vitest'

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({
    fillStyle: '',
    fillRect: vi.fn(),
  }),
  configurable: true,
  writable: true,
})

Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
  value: (cb: (blob: Blob | null) => void) => {
    cb(new Blob(['fake-jpeg-bytes'], { type: 'image/jpeg' }))
  },
  configurable: true,
  writable: true,
})
