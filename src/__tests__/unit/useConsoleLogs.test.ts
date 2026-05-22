import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

// Note:
// useConsoleLogs はモジュール初期化時に console をパッチする singleton。
// 各テストでは globalThis のフラグを落として、テスト毎に独立したパッチ状態を作る。
// vi.spyOn で console を置き換えた後に dynamic import することで、パッチが
// 「テスト時点の console」を捕まえるよう順序を制御する。

const ORIGINAL_ERROR = console.error
const ORIGINAL_WARN = console.warn
const ORIGINAL_LOG = console.log

async function loadHookFresh() {
  vi.resetModules()
  const mod = await import('../../hooks/useConsoleLogs')
  return mod
}

describe('useConsoleLogs', () => {
  beforeEach(() => {
    console.error = ORIGINAL_ERROR
    console.warn = ORIGINAL_WARN
    console.log = ORIGINAL_LOG
    ;(globalThis as Record<string, unknown>).__pecotoolConsolePatched__ = false
  })

  afterEach(() => {
    vi.restoreAllMocks()
    console.error = ORIGINAL_ERROR
    console.warn = ORIGINAL_WARN
    console.log = ORIGINAL_LOG
    ;(globalThis as Record<string, unknown>).__pecotoolConsolePatched__ = false
  })

  it('window not found はログパネルに追加しない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { useConsoleLogs } = await loadHookFresh()
    const { result, unmount } = renderHook(() => useConsoleLogs())

    act(() => {
      console.error(new Error('window not found'))
    })

    await waitFor(() => expect(result.current.logs).toEqual([]))
    unmount()
  })

  it('通常の console.error はログパネルに追加する', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { useConsoleLogs } = await loadHookFresh()
    const { result, unmount } = renderHook(() => useConsoleLogs())

    act(() => {
      console.error(new Error('permission denied'))
    })

    await waitFor(() => {
      expect(result.current.logs[0]?.message).toContain('permission denied')
    })
    unmount()
  })

  it('巨大文字列は MAX_LOG_LENGTH (5000) 以下に切り詰められる', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { useConsoleLogs } = await loadHookFresh()
    const { result, unmount } = renderHook(() => useConsoleLogs())

    const huge = 'x'.repeat(100_000)
    act(() => {
      console.error(huge)
    })

    await waitFor(() => {
      expect(result.current.logs.length).toBe(1)
    })
    const msg = result.current.logs[0]!.message
    expect(msg.length).toBeLessThanOrEqual(5000)
    expect(msg.endsWith('... [truncated]')).toBe(true)
    unmount()
  })

  it('巨大 Error オブジェクトも切り詰められる', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { useConsoleLogs } = await loadHookFresh()
    const { result, unmount } = renderHook(() => useConsoleLogs())

    const bigErr = new Error('boom: ' + 'y'.repeat(50_000))
    act(() => {
      console.error(bigErr)
    })

    await waitFor(() => {
      expect(result.current.logs.length).toBe(1)
    })
    expect(result.current.logs[0]!.message.length).toBeLessThanOrEqual(5000)
    unmount()
  })

  it('HMR 相当の再 import でも console は二重置換されない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // 1 回目の import で patch される (resetModules + import)
    await loadHookFresh()
    const patchedRef1 = console.error

    // この時点で console.error は patch されており、spy 自体とは別関数になっている。
    // 2 回目の import (HMR 相当: モジュールキャッシュをクリアして再評価) でも
    // globalThis フラグにより再パッチされず、console.error は変わらない。
    await loadHookFresh()
    const patchedRef2 = console.error

    expect(patchedRef2).toBe(patchedRef1)
  })

  it('購読中だけ window error listeners を登録する', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const { useConsoleLogs } = await loadHookFresh()
    const { unmount } = renderHook(() => useConsoleLogs())

    expect(addSpy).toHaveBeenCalledWith('error', expect.any(Function))
    expect(addSpy).toHaveBeenCalledWith('unhandledrejection', expect.any(Function))

    unmount()

    expect(removeSpy).toHaveBeenCalledWith('error', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('unhandledrejection', expect.any(Function))
  })

  it('300 件を超えると古いログが落ちる (上限が守られる)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { useConsoleLogs } = await loadHookFresh()
    const { result, unmount } = renderHook(() => useConsoleLogs())

    act(() => {
      for (let i = 0; i < 350; i++) {
        console.log(`msg-${i}`)
      }
    })

    await waitFor(() => {
      expect(result.current.logs.length).toBe(300)
    })
    // 最新の 300 件が残る (最後は msg-349)
    expect(result.current.logs[299]!.message).toContain('msg-349')
    // 最古は msg-50 (350-300)
    expect(result.current.logs[0]!.message).toContain('msg-50')
    unmount()
  })
})
