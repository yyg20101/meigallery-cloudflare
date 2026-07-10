#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import {
  assertMetaLiveEvidenceCanGateProduction,
  isValidMetaOwnerIdentifier,
  META_LIVE_EVENTS,
  writeMetaLiveEvidence,
} from './meta-live-verification-lib.mjs'
import { runCommand } from './release-verification-lib.mjs'

const YES_VALUES = new Set(['y', 'yes', '是'])
const EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000

export function buildMetaLiveEvidence(input) {
  const confirmedBy = String(input?.confirmedBy || '').trim()
  const pixelId = String(input?.pixelId || '').trim()
  const commit = String(input?.commit || '').trim()
  const verifiedAt = new Date(input?.now ?? Date.now())
  const eventResults = Array.isArray(input?.eventResults) ? input.eventResults : []

  if (!isValidMetaOwnerIdentifier(confirmedBy)) throw new Error('确认人只允许 owner 或 owner:<短标识>')
  if (!/^\d{5,30}$/.test(pixelId)) throw new Error('测试 Pixel ID 必须为 5 到 30 位数字')
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('当前 commit 必须为 40 位 SHA')
  if (Number.isNaN(verifiedAt.getTime())) throw new Error('验证时间非法')
  if (input?.noStartTrial !== true) throw new Error('必须明确确认 Test Events 中没有 StartTrial')

  const resultMap = new Map(eventResults.map(result => [result?.eventName, result]))
  if (eventResults.length !== META_LIVE_EVENTS.length || resultMap.size !== META_LIVE_EVENTS.length) {
    throw new Error('必须录入固定三事件的验证结果')
  }

  const events = META_LIVE_EVENTS.map(eventName => {
    const result = resultMap.get(eventName)
    const browserEventId = String(result?.browserEventId || '')
    const serverEventId = String(result?.serverEventId || '')
    if (!browserEventId || !serverEventId) throw new Error(`${eventName} 缺少 Browser 或 Server event ID`)
    if (browserEventId !== serverEventId) throw new Error(`${eventName} Browser/Server event ID 不一致`)
    if (result?.deduplicated !== true) throw new Error(`${eventName} 未确认去重`)

    return {
      eventName,
      browser: true,
      server: true,
      eventIdMatched: true,
      eventIdDigest: digestEventId(browserEventId),
      deduplicated: true,
    }
  })

  const evidence = {
    schemaVersion: 1,
    status: 'passed',
    commit,
    verifiedAt: verifiedAt.toISOString(),
    expiresAt: new Date(verifiedAt.getTime() + EVIDENCE_TTL_MS).toISOString(),
    pixelIdSuffix: pixelId.slice(-4),
    events,
    confirmedBy,
  }
  assertMetaLiveEvidenceCanGateProduction(evidence, {
    expectedCommit: commit,
    now: verifiedAt,
  })
  return evidence
}

export async function recordMetaLiveVerification(options = {}) {
  const ask = options.ask || createCliPrompter()
  const output = options.output || console.log
  const getCommit = options.getCommit || readCurrentCommit
  const writeEvidence = options.writeEvidence || writeMetaLiveEvidence
  const commit = await getCommit(options)
  const confirmedBy = await ask('确认人（owner 或 owner:<短标识>）：', { hidden: false })
  const pixelId = await ask('测试 Pixel ID：', { hidden: true })
  const eventResults = []

  for (const eventName of META_LIVE_EVENTS) {
    const browserEventId = await ask(`${eventName} Browser event ID：`, { hidden: true })
    const serverEventId = await ask(`${eventName} Server event ID：`, { hidden: true })
    const deduplicated = isYes(await ask(`${eventName} 已在 Events Manager 确认去重？(yes/no)：`, { hidden: false }))
    eventResults.push({ eventName, browserEventId, serverEventId, deduplicated })
  }

  const noStartTrial = isYes(await ask('已确认 Test Events 中没有 StartTrial？(yes/no)：', { hidden: false }))
  const evidence = buildMetaLiveEvidence({
    confirmedBy,
    pixelId,
    eventResults,
    noStartTrial,
    commit,
    now: options.now,
  })
  const files = await writeEvidence(evidence, {
    ...options,
    expectedCommit: commit,
    now: options.now,
  })
  output(`Meta live evidence 已写入：${files.evidenceFile}`)
  return { evidence, ...files }
}

function digestEventId(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`
}

function isYes(value) {
  return YES_VALUES.has(String(value || '').trim().toLowerCase())
}

async function readCurrentCommit(options = {}) {
  const runCommandFn = options.runCommand || runCommand
  const step = await runCommandFn('git', ['rev-parse', 'HEAD'], {
    cwd: options.cwd || process.cwd(),
    name: 'git-commit',
  })
  if (step.status !== 'passed') throw new Error('无法读取当前 Git commit')
  return String(step.stdout || '').trim()
}

function createCliPrompter() {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    const readline = createInterface({ input: process.stdin, output: process.stdout })
    return async prompt => readline.question(prompt)
  }

  return (prompt, { hidden }) => new Promise((resolve, reject) => {
    let answer = ''
    process.stdout.write(prompt)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')

    const cleanup = () => {
      process.stdin.off('data', onData)
      process.stdin.setRawMode(false)
      process.stdout.write('\n')
    }
    const onData = chunk => {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup()
          reject(new Error('用户取消录入'))
          return
        }
        if (character === '\r' || character === '\n') {
          cleanup()
          resolve(answer)
          return
        }
        if (character === '\u007f' || character === '\b') {
          if (answer.length > 0) answer = answer.slice(0, -1)
          if (!hidden) process.stdout.write('\b \b')
          continue
        }
        answer += character
        if (!hidden) process.stdout.write(character)
      }
    }
    process.stdin.on('data', onData)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await recordMetaLiveVerification()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
