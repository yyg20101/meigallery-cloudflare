import { describe, expect, it } from 'vitest'
import {
  filterApiProxyRequestHeaders,
  shouldForwardApiProxyResponseHeader,
} from './apiProxyHeaders'

describe('Web API 代理头部白名单', () => {
  it('仅转发 API 认证、内容协商和限流识别需要的请求头', () => {
    expect(filterApiProxyRequestHeaders({
      Cookie: ' mei_session=abc ',
      'Content-Type': ' application/json ',
      Accept: ' application/json ',
      Authorization: ' Bearer import-token ',
      'CF-Connecting-IP': '203.0.113.10',
      'X-Forwarded-For': '203.0.113.10, 198.51.100.2',
      'X-Real-IP': '203.0.113.10',
      'User-Agent': 'Mozilla/5.0',
    })).toEqual({
      accept: 'application/json',
      authorization: 'Bearer import-token',
      'cf-connecting-ip': '203.0.113.10',
      'content-type': 'application/json',
      cookie: 'mei_session=abc',
      'user-agent': 'Mozilla/5.0',
      'x-forwarded-for': '203.0.113.10, 198.51.100.2',
      'x-real-ip': '203.0.113.10',
    })
  })

  it('丢弃来源页、浏览器内部、代理连接和空值请求头', () => {
    expect(filterApiProxyRequestHeaders({
      Host: '616618.xyz',
      Origin: 'https://evil.example',
      Referer: 'https://616618.xyz/admin/settings',
      Connection: 'keep-alive',
      'Keep-Alive': 'timeout=5',
      'Transfer-Encoding': 'chunked',
      'Content-Length': '42',
      'Accept-Encoding': 'br, gzip',
      'Sec-Fetch-Site': 'same-origin',
      'X-Nuxt-Data': '1',
      'X-Forwarded-Host': 'evil.example',
      Cookie: '',
      Accept: undefined,
    })).toEqual({})
  })

  it('只转发浏览器和前端业务需要感知的响应头', () => {
    for (const name of [
      'Content-Type',
      'Cache-Control',
      'Set-Cookie',
      'ETag',
      'Location',
      'Retry-After',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'Content-Disposition',
    ]) {
      expect(shouldForwardApiProxyResponseHeader(name)).toBe(true)
    }
  })

  it('拒绝连接、压缩、长度和服务端指纹类响应头', () => {
    for (const name of [
      'Connection',
      'Transfer-Encoding',
      'Content-Length',
      'Content-Encoding',
      'Server',
      'X-Powered-By',
      'CF-Ray',
      'Report-To',
    ]) {
      expect(shouldForwardApiProxyResponseHeader(name)).toBe(false)
    }
  })
})
