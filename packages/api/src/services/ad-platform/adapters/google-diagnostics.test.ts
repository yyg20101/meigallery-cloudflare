import { describe, expect, it, vi } from 'vitest'
import { clearGoogleAccessTokenCacheForTests } from './google-auth'
import { retrieveGoogleRequestStatus } from './google-diagnostics'

describe('Google Data Manager 异步诊断 Adapter', () => {
  it.each([
    ['SUCCESS', 'processed'],
    ['PROCESSING', 'processing'],
    ['FAILED', 'rejected'],
    ['PARTIAL_SUCCESS', 'rejected'],
  ] as const)('将 %s 归一化为 %s', async (requestStatus, classification) => {
    clearGoogleAccessTokenCacheForTests()
    const fetcher = googleFetcher(new Response(JSON.stringify({
      requestStatusPerDestination: [{
        requestStatus,
        eventsIngestionStatus: { recordCount: '1' },
        errorInfo: { errorCounts: [{ recordCount: '1', reason: 'PROCESSING_ERROR_REASON_INVALID_GCLID' }] },
        warningInfo: { warningCounts: [{ recordCount: '1', reason: 'PROCESSING_WARNING_REASON_INTERNAL_ERROR' }] },
      }],
    }), { status: 200 }))

    const result = await retrieveGoogleRequestStatus({
      requestId: 'request_123', cloudProjectId: 'project-1', serviceAccount: await serviceAccount(), fetcher,
    })

    expect(result).toMatchObject({ classification, status: 200, requestStatus })
    expect(result.errorReasons).toEqual(['PROCESSING_ERROR_REASON_INVALID_GCLID'])
    expect(result.warningReasons).toEqual(['PROCESSING_WARNING_REASON_INTERNAL_ERROR'])
    expect(String(fetcher.mock.calls[1]?.[0])).toBe('https://datamanager.googleapis.com/v1/requestStatus:retrieve?requestId=request_123')
    expect(fetcher.mock.calls[1]?.[1]?.headers).toEqual({ Authorization: 'Bearer google-access-token', 'x-goog-user-project': 'project-1' })
  })

  it.each([
    [401, 'credential_invalid'],
    [404, 'processing'],
    [429, 'retryable'],
    [503, 'retryable'],
    [400, 'rejected'],
  ] as const)('清洗 HTTP %i 为 %s', async (status, classification) => {
    clearGoogleAccessTokenCacheForTests()
    const fetcher = googleFetcher(new Response(JSON.stringify({ error: { message: 'secret' } }), { status }))
    const result = await retrieveGoogleRequestStatus({ requestId: 'request_123', cloudProjectId: 'project-1', serviceAccount: await serviceAccount(), fetcher })
    expect(result).toEqual({ classification, status, requestStatus: '' })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('拒绝非法 requestId 和 Cloud Project 且不调用网络', async () => {
    const fetcher = vi.fn()
    await expect(retrieveGoogleRequestStatus({ requestId: '../secret', cloudProjectId: 'Project_1', serviceAccount: '{}', fetcher }))
      .resolves.toEqual({ classification: 'rejected', status: 0, requestStatus: '' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})

function googleFetcher(response: Response) {
  return vi.fn(async (url: string) => url.includes('/token')
    ? new Response(JSON.stringify({ access_token: 'google-access-token', expires_in: 3600 }), { status: 200 })
    : response)
}

async function serviceAccount() {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
  const privateKey = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  return JSON.stringify({ type: 'service_account', client_email: 'google-diagnostics@project.iam.gserviceaccount.com', token_uri: 'https://oauth2.googleapis.com/token', private_key: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...privateKey))}\n-----END PRIVATE KEY-----\n` })
}
