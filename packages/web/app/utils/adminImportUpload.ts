import { IMPORT_PACKAGE_LIMITS } from '@meigallery/shared/constants'

type JsonApi = <T>(
  path: string,
  options?: {
    method?: string
    body?: unknown
    headers?: Record<string, string>
    devAdminWriteConfirmation?: 'already-confirmed'
  },
) => Promise<T>

type RawApi = (
  path: string,
  options?: {
    method?: string
    body?: unknown
    headers?: Record<string, string>
    devAdminWriteConfirmation?: 'already-confirmed'
  },
) => Promise<Response>

interface ImportUploadPlan {
  uploadSession: string
  partSize: number
  partCount: number
}

interface AdminImportUploadOptions {
  onProgress?: (uploadedParts: number, partCount: number) => void
  devWriteAlreadyConfirmed?: boolean
}

/**
 * 使用同源 API 代理逐片上传 ZIP。每片都小于 Cloudflare 最低账户方案的请求体上限，
 * R2 uploadId 与分片 ETag 只由 API Worker/D1 持有，浏览器只携带一次性会话标识。
 */
export async function uploadAdminImportPackage(
  api: JsonApi,
  apiResponse: RawApi,
  jobId: string,
  file: File,
  options: AdminImportUploadOptions = {},
): Promise<void> {
  if (!file.name.toLocaleLowerCase('en-US').endsWith('.zip')) {
    throw new Error('请选择扩展名为 .zip 的导入包')
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > IMPORT_PACKAGE_LIMITS.MAX_ARCHIVE_BYTES) {
    throw new Error('ZIP 文件必须大于 0，且不能超过 256 MB')
  }
  const encodedJobId = encodeURIComponent(jobId)
  const plan = await api<ImportUploadPlan>(`/api/admin/import-jobs/${encodedJobId}/package/init`, {
    method: 'POST',
    body: { sourceName: file.name, packageSize: file.size },
    devAdminWriteConfirmation: options.devWriteAlreadyConfirmed ? 'already-confirmed' : undefined,
  })
  if (
    !/^[a-f0-9-]{36}$/i.test(plan.uploadSession)
    || !Number.isSafeInteger(plan.partSize)
    || plan.partSize !== IMPORT_PACKAGE_LIMITS.MULTIPART_PART_BYTES
    || !Number.isSafeInteger(plan.partCount)
    || plan.partCount !== Math.ceil(file.size / plan.partSize)
  ) {
    throw new Error('服务端返回的 ZIP 上传计划无效')
  }

  options.onProgress?.(0, plan.partCount)
  for (let index = 0; index < plan.partCount; index++) {
    const partNumber = index + 1
    const chunk = file.slice(index * plan.partSize, Math.min(file.size, partNumber * plan.partSize))
    await uploadPartWithRetry(
      apiResponse,
      `/api/admin/import-jobs/${encodedJobId}/package/parts/${partNumber}`,
      chunk,
      plan.uploadSession,
    )
    options.onProgress?.(partNumber, plan.partCount)
  }

  await api(`/api/admin/import-jobs/${encodedJobId}/package/complete`, {
    method: 'POST',
    body: { uploadSession: plan.uploadSession },
    devAdminWriteConfirmation: 'already-confirmed',
  })
}

async function uploadPartWithRetry(
  apiResponse: RawApi,
  path: string,
  chunk: Blob,
  uploadSession: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await apiResponse(path, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Import-Part-Size': String(chunk.size),
          'X-Import-Upload-Session': uploadSession,
        },
        body: chunk,
        devAdminWriteConfirmation: 'already-confirmed',
      })
      await response.json()
      return
    }
    catch (error) {
      if (attempt === 3 || !isRetryableUploadError(error)) throw error
      await delay(250 * attempt)
    }
  }
}

function isRetryableUploadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const status = Number((error as { statusCode?: unknown }).statusCode)
  return status === 429 || status >= 500
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
