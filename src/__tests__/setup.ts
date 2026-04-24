/**
 * vitest global setup
 * jsdom は canvas を実装しないため、pdfSaver が使う最小限のスタブを用意する。
 */
import { vi } from 'vitest'

// scrollIntoView は jsdom で未実装のため no-op に差し替え
Element.prototype.scrollIntoView = vi.fn()

// Global Worker stub for JSDOM
class MockWorker {
  onmessage: (e: any) => void = () => {}
  postMessage(data: any) {
    // Simple echo for testing or just enough to not hang
    setTimeout(() => {
      if (this.onmessage) this.onmessage({ data });
      this.listeners.forEach(l => {
        if (l.type === 'message') l.cb({ data });
      });
    }, 0);
  }
  listeners: Array<{type: string, cb: any}> = []
  terminate() {}
  addEventListener(type: string, cb: any) {
    this.listeners.push({ type, cb });
  }
  removeEventListener(_type: string, cb: any) {
    this.listeners = this.listeners.filter(l => l.cb !== cb);
  }
}

if (typeof window !== 'undefined' && !window.Worker) {
  (window as any).Worker = MockWorker;
}

// Mock Vite ?worker query for all tests
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?worker', () => ({
  default: MockWorker
}))

// Mock lucide-react globally to avoid missing icon errors
vi.mock('lucide-react', async (importOriginal) => {
  const actual = await importOriginal() as any;
  const mockIcons: any = {};
  // Create a simple functional component for any requested icon
  return new Proxy(actual, {
    get: (target, prop) => {
      if (prop in target) return target[prop];
      if (!mockIcons[prop as string]) {
        mockIcons[prop as string] = () => null;
      }
      return mockIcons[prop as string];
    }
  });
})

// Mock Tauri APIs that might be imported globally
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((path) => `asset://${path}`),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  stat: vi.fn().mockResolvedValue({ mtime: new Date('2024-01-01') }),
}))

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({
    fillStyle: '',
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
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
