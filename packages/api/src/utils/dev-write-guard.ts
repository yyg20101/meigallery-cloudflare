const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function shouldBlockDevWrite(appEnv: string | undefined, devWriteEnabled: string | undefined, method: string) {
  return appEnv === 'dev' && devWriteEnabled !== 'true' && !SAFE_METHODS.has(method.toUpperCase())
}
