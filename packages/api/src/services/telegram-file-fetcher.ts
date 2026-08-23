import { ImportError, type ImportErrorCode } from '../utils/import-errors'
import {
  assertSupportedImageBytes,
  sanitizeImportedImage,
  ZipImportError,
} from './admin-zip-package'

type TelegramSecretEnv = Record<string, string | undefined>

export type FetchedTelegramImage = {
  bytes: Uint8Array
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  fileSize: number
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_GET_FILE_RESPONSE_BYTES = 256 * 1024
const TELEGRAM_REQUEST_TIMEOUT_MS = 60_000
const MIME_TO_EXT: Record<FetchedTelegramImage['mimeType'], string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

export function getTelegramSecretName(sourceBotKey: string): string {
  return `TELEGRAM_BOT_TOKEN_${sourceBotKey.toUpperCase()}`
}

export function getExtensionForMime(mimeType: FetchedTelegramImage['mimeType']): string {
  return MIME_TO_EXT[mimeType]
}

export async function fetchTelegramImageFile(env: TelegramSecretEnv, sourceBotKey: string, fileId: string): Promise<FetchedTelegramImage> {
  const secretName = getTelegramSecretName(sourceBotKey)
  const botToken = env[secretName]
  if (!botToken) throw new ImportError('TELEGRAM_BOT_TOKEN_MISSING', '未配置 Telegram Bot Token', 500)

  let getFileResponse: Response
  try {
    getFileResponse = await fetch(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
      { signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS) },
    )
  } catch {
    throw new ImportError('TELEGRAM_GET_FILE_FAILED', 'Telegram getFile 调用失败', 502)
  }
  const getFileBytes = await readBoundedResponseBytes(
    getFileResponse,
    MAX_GET_FILE_RESPONSE_BYTES,
    'TELEGRAM_GET_FILE_FAILED',
    'Telegram getFile 响应无效',
  )
  let getFileJson: { ok: boolean; result?: { file_path?: string; file_size?: number } }
  try {
    getFileJson = JSON.parse(new TextDecoder().decode(getFileBytes)) as typeof getFileJson
  } catch {
    throw new ImportError('TELEGRAM_GET_FILE_FAILED', 'Telegram getFile 响应无效', 502)
  }
  const getFileResult = getFileJson.result
  if (!getFileResponse.ok || getFileJson.ok !== true || !getFileResult || !safeTelegramFilePath(getFileResult.file_path)) {
    throw new ImportError('TELEGRAM_GET_FILE_FAILED', 'Telegram getFile 调用失败', 502)
  }
  const remoteFileSize = getFileResult.file_size
  if (remoteFileSize !== undefined && (!Number.isSafeInteger(remoteFileSize) || remoteFileSize < 0)) {
    throw new ImportError('TELEGRAM_GET_FILE_FAILED', 'Telegram getFile 响应无效', 502)
  }
  if ((remoteFileSize ?? 0) > MAX_IMAGE_BYTES) throw new ImportError('TELEGRAM_FILE_TOO_LARGE', 'Telegram 文件超过 10MB', 400)

  let downloadResponse: Response
  try {
    downloadResponse = await fetch(
      `https://api.telegram.org/file/bot${botToken}/${getFileResult.file_path}`,
      { signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS) },
    )
  } catch {
    throw new ImportError('TELEGRAM_DOWNLOAD_FAILED', 'Telegram 文件下载失败', 502)
  }
  if (!downloadResponse.ok) throw new ImportError('TELEGRAM_DOWNLOAD_FAILED', 'Telegram 文件下载失败', 502)

  const contentType = downloadResponse.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()
  if (contentType !== 'image/jpeg' && contentType !== 'image/png' && contentType !== 'image/webp') throw new ImportError('TELEGRAM_FILE_TYPE_UNSUPPORTED', 'Telegram 文件类型不支持', 400)

  const sourceBytes = await readBoundedResponseBytes(
    downloadResponse,
    MAX_IMAGE_BYTES,
    'TELEGRAM_FILE_TOO_LARGE',
    'Telegram 文件超过 10MB',
  )
  if (sourceBytes.byteLength === 0) {
    throw new ImportError('TELEGRAM_FILE_EMPTY', 'Telegram 文件没有内容', 400)
  }

  let extension: 'jpg' | 'png' | 'webp'
  try {
    extension = assertSupportedImageBytes(sourceBytes, 'Telegram 导入图片')
  } catch (error) {
    if (error instanceof ZipImportError) {
      throw new ImportError('TELEGRAM_FILE_CONTENT_INVALID', 'Telegram 文件内容不是受支持图片', 400)
    }
    throw error
  }
  const bytes = sanitizeImportedImage(sourceBytes, extension)
  const actualMimeType: FetchedTelegramImage['mimeType'] = extension === 'jpg'
    ? 'image/jpeg'
    : extension === 'png' ? 'image/png' : 'image/webp'
  return { bytes, mimeType: actualMimeType, fileSize: bytes.byteLength }
}

function safeTelegramFilePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !value.startsWith('/')
    && !value.includes('..')
    && /^[A-Za-z0-9_./-]+$/.test(value)
}

async function readBoundedResponseBytes(
  response: Response,
  maxBytes: number,
  errorCode: ImportErrorCode,
  errorMessage: string,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new ImportError(errorCode, errorMessage, errorCode === 'TELEGRAM_FILE_TOO_LARGE' ? 400 : 502)
  }
  if (!response.body) {
    throw new ImportError(errorCode, errorMessage, errorCode === 'TELEGRAM_FILE_TOO_LARGE' ? 400 : 502)
  }

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
          // 保留原始边界错误；连接取消失败不改变安全结论。
        }
        throw new ImportError(errorCode, errorMessage, errorCode === 'TELEGRAM_FILE_TOO_LARGE' ? 400 : 502)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
