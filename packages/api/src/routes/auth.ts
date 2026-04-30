import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'

export const authRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// POST /api/auth/register
authRoutes.post('/register', async (c) => {
  // TODO: 实现注册逻辑
  return c.json({ message: '注册接口待实现' }, 501)
})

// POST /api/auth/login
authRoutes.post('/login', async (c) => {
  // TODO: 实现登录逻辑
  return c.json({ message: '登录接口待实现' }, 501)
})

// POST /api/auth/logout
authRoutes.post('/logout', async (c) => {
  // TODO: 实现登出逻辑
  return c.json({ message: '登出接口待实现' }, 501)
})
