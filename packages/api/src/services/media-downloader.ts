/**
 * 媒体下载服务
 * 从 WordPress 原始 URL 下载图片到 R2，视频到 Stream
 */

import { R2_KEY_PREFIX } from '@meigallery/shared/constants'

export interface DownloadResult {
  assetId: string
  success: boolean
  r2Key?: string
  streamUid?: string
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
    const response = await fetch(sourceUrl)
    if (!response.ok) {
      return { assetId, success: false, error: `HTTP ${response.status}` }
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg'
    const ext = contentType.includes('png') ? 'png'
      : contentType.includes('webp') ? 'webp'
      : contentType.includes('gif') ? 'gif'
      : 'jpg'

    const r2Key = `${R2_KEY_PREFIX.ORIGINALS}/${galleryId}/${assetId}.${ext}`

    await r2.put(r2Key, response.body, {
      httpMetadata: { contentType },
    })

    return { assetId, success: true, r2Key }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '未知错误'
    return { assetId, success: false, error: message }
  }
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
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: sourceUrl,
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
      const errorMsg = result.errors?.[0]?.message || 'Stream API 错误'
      return { assetId, success: false, error: errorMsg }
    }

    return { assetId, success: true, streamUid: result.result.uid }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '未知错误'
    return { assetId, success: false, error: message }
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
