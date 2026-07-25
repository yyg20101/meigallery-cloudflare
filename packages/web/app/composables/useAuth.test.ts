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
  it('registration POST 复用统一 API 客户端以转发 HttpOnly cookie', async () => {
    api.mockResolvedValue({
      id: 22,
      email: 'mei@example.com',
      attributionInstructionToken: null,
    })
    const params = {
      email: 'mei@example.com',
      password: 'password123',
      username: 'meiuser',
      attribution: { path: '/register' },
    }

    await useAuth().register(params)

    expect(api).toHaveBeenCalledWith('/api/auth/register', {
      method: 'POST',
      body: params,
    })
  })
})
