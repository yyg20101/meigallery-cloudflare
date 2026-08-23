/**
 * 媒体下载服务
 * 从 WordPress 原始 URL 下载图片到 R2，视频到 Stream
 */

import { IMPORT_PACKAGE_LIMITS, R2_KEY_PREFIX } from '@meigallery/shared/constants'
import { assertSafeExternalUrl, safeExternalFetch } from '../utils/external-url'
import {
  assertSupportedImageBytes,
  sanitizeImportedImage,
  ZipImportError,
} from './admin-zip-package'

const REMOTE_MEDIA_REQUEST_TIMEOUT_MS = 60_000

export interface DownloadResult {
  assetId: string
  success: boolean
  r2Key?: string
  streamUid?: string
  errorCode?: string
  error?: string
}

/**
 * 下载单张图片到 R2
 */
export async function downloadImageToR2(
  r2: R2Bucket,
  sourceUrl: string,
  galleryId: string,
  assetId: string,
): Promise<DownloadResult> {
  try {
    const response = await safeExternalFetch(sourceUrl, {
      signal: AbortSignal.timeout(REMOTE_MEDIA_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      return {
        assetId,
        success: false,
        errorCode: 'LEGACY_MEDIA_REMOTE_HTTP_ERROR',
        error: `远程图片返回 HTTP ${response.status}`,
      }
    }

    const sourceBytes = await readBoundedResponseBytes(
      response,
      IMPORT_PACKAGE_LIMITS.MAX_IMAGE_ENTRY_BYTES,
    )
    const ext = assertSupportedImageBytes(sourceBytes, `旧站媒体 ${assetId}`)
    const bytes = sanitizeImportedImage(sourceBytes, ext)
    const contentType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`

    const r2Key = `${R2_KEY_PREFIX.ORIGINALS}/${galleryId}/${assetId}.${ext}`

    await r2.put(r2Key, bytes, {
      httpMetadata: { contentType },
    })

    return { assetId, success: true, r2Key }
  } catch (err: unknown) {
    const failure = safeImageDownloadFailure(err)
    if (failure.errorCode === 'LEGACY_MEDIA_REMOTE_DOWNLOAD_FAILED') {
      console.error(JSON.stringify({
        event: 'legacy_media_download_failed',
        assetId,
        errorCode: failure.errorCode,
        errorName: err instanceof Error ? err.name : 'UnknownError',
      }))
    }
    return { assetId, success: false, ...failure }
  }
}

function safeImageDownloadFailure(error: unknown): Pick<DownloadResult, 'errorCode' | 'error'> {
  if (error instanceof ZipImportError) {
    return { errorCode: error.code, error: error.message }
  }
  if (error instanceof Error && error.message === '远程图片超过 10 MiB 上限') {
    return { errorCode: 'LEGACY_MEDIA_REMOTE_TOO_LARGE', error: error.message }
  }
  if (error instanceof Error && error.message === '远程图片响应没有内容') {
    return { errorCode: 'LEGACY_MEDIA_REMOTE_EMPTY', error: error.message }
  }
  return {
    errorCode: 'LEGACY_MEDIA_REMOTE_DOWNLOAD_FAILED',
    error: '远程图片下载或存储失败，请稍后重试',
  }
}

async function readBoundedResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new Error('远程图片超过 10 MiB 上限')
  }
  if (!response.body) throw new Error('远程图片响应没有内容')

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel()
        } catch {
          // 保留原始大小错误；连接取消失败不改变安全结论。
        }
        throw new Error('远程图片超过 10 MiB 上限')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const result = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

/**
 * 上传视频到 Cloudflare Stream
 */
export async function uploadVideoToStream(
  accountId: string,
  apiToken: string,
  sourceUrl: string,
  assetId: string,
): Promise<DownloadResult> {
  try {
    // 使用 Stream 的 URL 上传（copy）功能
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/copy`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(REMOTE_MEDIA_REQUEST_TIMEOUT_MS),
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: assertSafeExternalUrl(sourceUrl),
          meta: { name: assetId },
          requireSignedURLs: true,
        }),
      },
    )

    const result = await response.json() as {
      success: boolean
      result?: { uid?: string }
      errors?: Array<{ message: string }>
    }

    if (!result.success || !result.result?.uid) {
      return {
        assetId,
        success: false,
        errorCode: 'LEGACY_STREAM_COPY_FAILED',
        error: 'Stream 复制任务创建失败',
      }
    }

    return { assetId, success: true, streamUid: result.result.uid }
  } catch (err: unknown) {
    console.error(JSON.stringify({
      event: 'legacy_stream_copy_failed',
      assetId,
      errorCode: 'LEGACY_STREAM_COPY_FAILED',
      errorName: err instanceof Error ? err.name : 'UnknownError',
    }))
    return {
      assetId,
      success: false,
      errorCode: 'LEGACY_STREAM_COPY_FAILED',
      error: 'Stream 复制任务创建失败',
    }
  }
}

/**
 * 批量下载图库的所有待处理媒体
 */
export async function downloadGalleryMedia(
  db: D1Database,
  r2: R2Bucket,
  streamAccountId: string,
  streamApiToken: string,
  galleryId: string,
): Promise<{ downloaded: number; failed: number; errors: string[] }> {
  const assets = await db
    .prepare(
      "SELECT id, type, r2_key FROM media_assets WHERE gallery_id = ? AND upload_status = 'pending'",
    )
    .bind(galleryId)
    .all<{ id: string; type: string; r2_key: string | null }>()

  let downloaded = 0
  let failed = 0
  const errors: string[] = []

  for (const asset of assets.results) {
    if (!asset.r2_key) continue // 没有源 URL

    if (asset.type === 'image') {
      const result = await downloadImageToR2(r2, asset.r2_key, galleryId, asset.id)
      if (result.success && result.r2Key) {
        await db
          .prepare("UPDATE media_assets SET r2_key = ?, upload_status = 'completed' WHERE id = ?")
          .bind(result.r2Key, asset.id)
          .run()
        downloaded++
      } else {
        await db
          .prepare("UPDATE media_assets SET upload_status = 'failed' WHERE id = ?")
          .bind(asset.id)
          .run()
        failed++
        errors.push(`图片 ${asset.id}: ${result.error}`)
      }
    } else if (asset.type === 'video') {
      const result = await uploadVideoToStream(
        streamAccountId,
        streamApiToken,
        asset.r2_key,
        asset.id,
      )
      if (result.success && result.streamUid) {
        await db
          .prepare(
            "UPDATE media_assets SET stream_uid = ?, r2_key = NULL, upload_status = 'completed' WHERE id = ?",
          )
          .bind(result.streamUid, asset.id)
          .run()
        downloaded++
      } else {
        await db
          .prepare("UPDATE media_assets SET upload_status = 'failed' WHERE id = ?")
          .bind(asset.id)
          .run()
        failed++
        errors.push(`视频 ${asset.id}: ${result.error}`)
      }
    }
  }

  return { downloaded, failed, errors }
}
