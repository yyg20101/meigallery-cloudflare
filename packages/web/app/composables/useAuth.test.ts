import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { useAuth } from './useAuth'

const api = vi.fn()
const states = new Map<string, ReturnType<typeof ref>>()

beforeEach(() => {
  api.mockReset()
  states.clear()
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
    if (!states.has(key)) states.set(key, ref(init()))
    return states.get(key)
  })
  vi.stubGlobal('useApi', () => ({ api }))
})

afterEach(() => vi.unstubAllGlobals())

describe('useAuth 注册', () => {
  it('registration POST 显式走 Web 同源代理以转发 HttpOnly marketing receipt', async () => {
    api.mockResolvedValue({ id: 22, email: 'mei@example.com', pixelEvents: [] })
    const params = {
      email: 'mei@example.com',
      password: 'password123',
      username: 'meiuser',
      attribution: { consentState: 'granted' as const },
    }

    await useAuth().register(params)

    expect(api).toHaveBeenCalledWith('/api/auth/register', {
      method: 'POST',
      body: params,
      sameOrigin: true,
    })
  })
})
