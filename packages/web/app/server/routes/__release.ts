interface CloudflareReleaseEnv {
  RELEASE_COMMIT?: string
  NUXT_PUBLIC_APP_ENV?: string
}

export interface ReleaseIdentity {
  status: 'ok' | 'unhealthy'
  environment: string | null
  commit: string | null
  errors: string[]
}

export function buildReleaseIdentity(env: CloudflareReleaseEnv | undefined): ReleaseIdentity {
  const environment = String(env?.NUXT_PUBLIC_APP_ENV || '').trim()
  const releaseCommit = String(env?.RELEASE_COMMIT || '').trim()
  const environmentValid = /^(production|dev|test|development)$/.test(environment)
  const commitValid = /^[0-9a-f]{40}$/i.test(releaseCommit)

  return {
    status: environmentValid && commitValid ? 'ok' : 'unhealthy',
    environment: environmentValid ? environment : null,
    commit: commitValid ? releaseCommit.toLowerCase() : null,
    errors: [
      ...(environmentValid ? [] : ['NUXT_PUBLIC_APP_ENV_INVALID']),
      ...(commitValid ? [] : ['RELEASE_COMMIT_INVALID']),
    ],
  }
}

export default defineEventHandler((event) => {
  const cloudflareEnv = (event.context as Record<string, any>).cloudflare?.env as CloudflareReleaseEnv | undefined
  const identity = buildReleaseIdentity(cloudflareEnv)

  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'Content-Type', 'application/json; charset=utf-8')
  if (identity.status !== 'ok') setResponseStatus(event, 503)
  return identity
})
