import { describe, it, expect, afterEach } from 'vitest'
import { isTauriRuntime } from '../../utils/isTauriRuntime'

describe('isTauriRuntime', () => {
  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__
  })

  it('window.__TAURI_INTERNALS__ が無い場合は false を返す (ブラウザ単体起動)', () => {
    delete (window as any).__TAURI_INTERNALS__
    expect(isTauriRuntime()).toBe(false)
  })

  it('window.__TAURI_INTERNALS__ がある場合は true を返す (Tauri ランタイム / E2E モック)', () => {
    ;(window as any).__TAURI_INTERNALS__ = { metadata: {} }
    expect(isTauriRuntime()).toBe(true)
  })
})
