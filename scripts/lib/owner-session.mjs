const SESSION_PATTERN = /^[a-f0-9]{64}$/

export function normalizeOwnerSession(value) {
  const input = String(value ?? '').trim()
  const token = input.includes('=')
    ? input
      .split(';')
      .map(item => item.trim())
      .find(item => item.startsWith('mei_session='))
      ?.slice('mei_session='.length)
    : input
  if (!token || !SESSION_PATTERN.test(token)) {
    throw new Error('ATTRIBUTION_MIGRATION_ADMIN_SESSION_INVALID')
  }
  return `mei_session=${token}`
}

export function readHiddenOwnerSession() {
  return readHiddenInput(
    '请输入 Owner 会话 token（输入不会显示）: ',
    'ATTRIBUTION_MIGRATION_ADMIN_SESSION_REQUIRED',
  )
}

export function readHiddenInput(
  prompt,
  requiredError,
  options = {},
) {
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const maxLength = options.maxLength ?? 8_192
  if (
    !stdin.isTTY
    || !stdout.isTTY
    || typeof stdin.setRawMode !== 'function'
  ) {
    throw new Error(requiredError)
  }
  stdout.write(prompt)
  return new Promise((resolve, reject) => {
    const originalRawMode = stdin.isRaw
    let value = ''

    const cleanup = () => {
      stdin.off('data', onData)
      stdin.setRawMode(Boolean(originalRawMode))
      stdin.pause()
      stdout.write('\n')
    }
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === '\u0003') {
          cleanup()
          reject(new Error('ATTRIBUTION_OPERATION_CANCELLED'))
          return
        }
        if (character === '\r' || character === '\n') {
          cleanup()
          resolve(value)
          return
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1)
          continue
        }
        if (character >= ' ' && value.length < maxLength) {
          value += character
        }
      }
    }

    stdin.setEncoding('utf8')
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}
