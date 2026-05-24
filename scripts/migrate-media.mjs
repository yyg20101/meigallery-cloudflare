#!/usr/bin/env node
/**
 * 媒体下载脚本 — 调用已部署的 API Worker 批量下载媒体到 R2
 * 
 * Worker 端点: POST /api/admin/legacy-import/download-pending?limit=N
 * 每次处理 N 个待上传媒体，循环直到全部完成
 * 
 * 用法:
 *   MEIGALLERY_ADMIN_EMAIL=... MEIGALLERY_ADMIN_PASSWORD=... node scripts/migrate-media.mjs [--batch=10] [--env=dev|production]
 *   MEIGALLERY_SESSION_COOKIE='mei_session=...' node scripts/migrate-media.mjs [--batch=10] [--env=dev|production]
 */

const API_BASE = {
  production: 'https://api.616618.xyz',
  dev: 'http://localhost:8787',
}

// 解析命令行参数
const args = process.argv.slice(2)
const batchSize = parseInt(args.find(a => a.startsWith('--batch='))?.split('=')[1] || '10', 10)
const env = args.find(a => a.startsWith('--env='))?.split('=')[1] || 'production'
const apiBase = API_BASE[env] || API_BASE.production
const adminEmail = process.env.MEIGALLERY_ADMIN_EMAIL
const adminPassword = process.env.MEIGALLERY_ADMIN_PASSWORD
const providedSessionCookie = process.env.MEIGALLERY_SESSION_COOKIE

console.log(`🖼️  媒体下载 → R2`)
console.log(`   API: ${apiBase}`)
console.log(`   批次大小: ${batchSize}`)
console.log('='.repeat(60))

// 登录获取 session cookie
async function login() {
  if (providedSessionCookie) {
    return providedSessionCookie.startsWith('mei_session=')
      ? providedSessionCookie
      : `mei_session=${providedSessionCookie}`
  }

  if (!adminEmail || !adminPassword) {
    throw new Error('缺少管理员凭据：请设置 MEIGALLERY_ADMIN_EMAIL 和 MEIGALLERY_ADMIN_PASSWORD，或直接设置 MEIGALLERY_SESSION_COOKIE')
  }

  console.log('\n🔐 登录管理员账户...')
  const resp = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: adminEmail,
      password: adminPassword,
    }),
    redirect: 'manual',
  })

  if (!resp.ok && resp.status !== 302) {
    const text = await resp.text()
    throw new Error(`登录失败: ${resp.status} ${text.slice(0, 200)}`)
  }

  // 获取 Set-Cookie
  const cookies = resp.headers.getSetCookie?.() || []
  const sessionCookie = cookies.find(c => c.startsWith('mei_session='))
  if (!sessionCookie) {
    // 可能返回了 JSON body 中的 token
    const data = await resp.json().catch(() => null)
    if (data?.token) {
      return `mei_session=${data.token}`
    }
    throw new Error('登录成功但未获取到 session cookie')
  }
  return sessionCookie.split(';')[0]
}

async function downloadBatch(cookie, limit) {
  const resp = await fetch(`${apiBase}/api/admin/legacy-import/download-pending?limit=${limit}`, {
    method: 'POST',
    headers: {
      'Cookie': cookie,
      'Content-Type': 'application/json',
    },
  })

  if (resp.status === 401) {
    throw new Error('SESSION_EXPIRED')
  }

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`API 错误: ${resp.status} ${text.slice(0, 200)}`)
  }

  return resp.json()
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  let cookie = await login()
  console.log('  ✅ 登录成功\n')

  let totalDownloaded = 0
  let totalFailed = 0
  let round = 0

  while (true) {
    round++
    try {
      const result = await downloadBatch(cookie, batchSize)

      totalDownloaded += result.downloaded || 0
      totalFailed += result.failed || 0

      process.stdout.write(
        `\r  批次 ${round} | 本次: +${result.downloaded}/-${result.failed} | 累计: ${totalDownloaded} 成功, ${totalFailed} 失败 | 剩余: ${result.remaining ?? '?'}`
      )

      if (result.errors?.length > 0) {
        console.log(`\n    错误: ${result.errors.slice(0, 3).join('; ')}`)
      }

      if (result.done || result.remaining === 0) {
        break
      }

      // 避免过载 Worker
      await sleep(500)
    } catch (err) {
      if (err.message === 'SESSION_EXPIRED') {
        console.log('\n  🔑 Session 过期，重新登录...')
        cookie = await login()
        continue
      }
      console.error(`\n  ❌ 批次 ${round} 失败: ${err.message}`)
      // 等待后重试
      await sleep(2000)
      if (round > 500) {
        console.error('  超过最大重试次数，退出')
        break
      }
    }
  }

  console.log('\n\n' + '='.repeat(60))
  console.log('✅ 媒体下载完成!')
  console.log(`   成功: ${totalDownloaded}`)
  console.log(`   失败: ${totalFailed}`)
  console.log(`   总批次: ${round}`)
}

main().catch(err => {
  console.error('❌ 脚本失败:', err.message)
  process.exit(1)
})
