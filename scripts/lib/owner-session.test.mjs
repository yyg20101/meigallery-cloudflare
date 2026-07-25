import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import { readHiddenInput } from './owner-session.mjs'

describe('Owner 隐藏输入', () => {
  it('提交时处理退格与长度上限并恢复终端状态', async () => {
    const stdin = new FakeStdin()
    const stdout = new FakeStdout()
    const input = readHiddenInput('请输入: ', 'INPUT_REQUIRED', {
      stdin,
      stdout,
      maxLength: 4,
    })

    stdin.emit('data', 'ab\u007fcdef\n')

    assert.equal(await input, 'acde')
    assert.deepEqual(stdin.rawModes, [true, false])
    assert.equal(stdin.encoding, 'utf8')
    assert.equal(stdin.resumeCalls, 1)
    assert.equal(stdin.pauseCalls, 1)
    assert.equal(stdin.listenerCount('data'), 0)
    assert.equal(stdin.listenerCount('error'), 0)
    assert.equal(stdout.output, '请输入: \n')
  })

  it('取消输入时拒绝并清理终端监听', async () => {
    const stdin = new FakeStdin({ isRaw: true })
    const stdout = new FakeStdout()
    const input = readHiddenInput('请输入: ', 'INPUT_REQUIRED', {
      stdin,
      stdout,
    })

    stdin.emit('data', '\u0003')

    await assert.rejects(
      input,
      /ATTRIBUTION_OPERATION_CANCELLED/,
    )
    assert.deepEqual(stdin.rawModes, [true, true])
    assert.equal(stdin.pauseCalls, 1)
    assert.equal(stdin.listenerCount('data'), 0)
    assert.equal(stdin.listenerCount('error'), 0)
  })

  it('标准输入错误时拒绝并恢复终端状态', async () => {
    const stdin = new FakeStdin()
    const stdout = new FakeStdout()
    const input = readHiddenInput('请输入: ', 'INPUT_REQUIRED', {
      stdin,
      stdout,
    })
    const failure = new Error('stdin failed')

    stdin.emit('error', failure)

    await assert.rejects(input, failure)
    assert.deepEqual(stdin.rawModes, [true, false])
    assert.equal(stdin.pauseCalls, 1)
    assert.equal(stdin.listenerCount('data'), 0)
    assert.equal(stdin.listenerCount('error'), 0)
  })

  it('非交互终端在输出提示前直接拒绝', () => {
    const stdin = new FakeStdin({ isTTY: false })
    const stdout = new FakeStdout()

    assert.throws(
      () => readHiddenInput('请输入: ', 'INPUT_REQUIRED', {
        stdin,
        stdout,
      }),
      /INPUT_REQUIRED/,
    )
    assert.equal(stdout.output, '')
    assert.deepEqual(stdin.rawModes, [])
  })
})

class FakeStdin extends EventEmitter {
  constructor(options = {}) {
    super()
    this.isTTY = options.isTTY ?? true
    this.isRaw = options.isRaw ?? false
    this.rawModes = []
    this.encoding = ''
    this.resumeCalls = 0
    this.pauseCalls = 0
  }

  setEncoding(value) {
    this.encoding = value
  }

  setRawMode(value) {
    this.rawModes.push(value)
    this.isRaw = value
  }

  resume() {
    this.resumeCalls += 1
  }

  pause() {
    this.pauseCalls += 1
  }
}

class FakeStdout {
  isTTY = true
  output = ''

  write(value) {
    this.output += value
  }
}
