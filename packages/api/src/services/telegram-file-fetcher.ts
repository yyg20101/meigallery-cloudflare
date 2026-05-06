import { ImportError } from '../utils/import-errors'

type TelegramSecretEnv = Record<string, string | undefined>

export type FetchedTelegramImage = {
  bytes: ArrayBuffer
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  fileSize: number
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
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

  const getFileResponse = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`)
  const getFileJson = await getFileResponse.json<{ ok: boolean; result?: { file_path?: string; file_size?: number } }>()
  if (!getFileResponse.ok || !getFileJson.ok || !getFileJson.result?.file_path) throw new ImportError('TELEGRAM_GET_FILE_FAILED', 'Telegram getFile 调用失败', 502)
  if ((getFileJson.result.file_size ?? 0) > MAX_IMAGE_BYTES) throw new ImportError('TELEGRAM_FILE_TOO_LARGE', 'Telegram 文件超过 10MB', 400)

  const downloadResponse = await fetch(`https://api.telegram.org/file/bot${botToken}/${getFileJson.result.file_path}`)
  if (!downloadResponse.ok) throw new ImportError('TELEGRAM_DOWNLOAD_FAILED', 'Telegram 文件下载失败', 502)

  const contentType = downloadResponse.headers.get('Content-Type')?.split(';')[0]
  if (contentType !== 'image/jpeg' && contentType !== 'image/png' && contentType !== 'image/webp') throw new ImportError('TELEGRAM_FILE_TYPE_UNSUPPORTED', 'Telegram 文件类型不支持', 400)

  const bytes = await downloadResponse.arrayBuffer()
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new ImportError('TELEGRAM_FILE_TOO_LARGE', 'Telegram 文件超过 10MB', 400)
  return { bytes, mimeType: contentType, fileSize: bytes.byteLength }
}
