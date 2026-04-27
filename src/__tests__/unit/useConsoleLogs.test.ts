import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useConsoleLogs } from '../../hooks/useConsoleLogs'

describe('useConsoleLogs', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('window not found はログパネルに追加しない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result, unmount } = renderHook(() => useConsoleLogs())

    act(() => {
      console.error(new Error('window not found'))
    })

    await waitFor(() => expect(result.current.logs).toEqual([]))
    unmount()
  })

  it('通常の console.error はログパネルに追加する', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result, unmount } = renderHook(() => useConsoleLogs())

    act(() => {
      console.error(new Error('permission denied'))
    })

    await waitFor(() => {
      expect(result.current.logs[0]?.message).toContain('permission denied')
    })
    unmount()
  })
})
