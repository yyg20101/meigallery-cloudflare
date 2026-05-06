export type ImportErrorCode =
  | 'IMPORT_TOKEN_MISSING'
  | 'IMPORT_TOKEN_INVALID'
  | 'IMPORT_TOKEN_DISABLED'
  | 'IMPORT_TOKEN_EXPIRED'
  | 'IMPORT_PERMISSION_DENIED'
  | 'IMPORT_SOURCE_BOT_NOT_ALLOWED'
  | 'IMPORT_VALIDATION_FAILED'
  | 'IMPORT_DUPLICATE'
  | 'IMPORT_NOT_FOUND'
  | 'IMPORT_RETRY_NOT_ALLOWED'
  | 'IMPORT_RETRY_CLEANUP_REQUIRED'
  | 'TELEGRAM_BOT_TOKEN_MISSING'
  | 'TELEGRAM_GET_FILE_FAILED'
  | 'TELEGRAM_DOWNLOAD_FAILED'
  | 'TELEGRAM_FILE_TOO_LARGE'
  | 'TELEGRAM_FILE_TYPE_UNSUPPORTED'
  | 'IMPORT_TARGET_SLUG_CONFLICT'
  | 'IMPORT_PROCESS_FAILED'

export type ImportErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500

export class ImportError extends Error {
  constructor(
    public readonly code: ImportErrorCode,
    message: string,
    public readonly status: ImportErrorStatus = 400,
  ) {
    super(message)
  }
}

export function importErrorBody(error: ImportError) {
  return {
    statusCode: error.status,
    code: error.code,
    message: error.message,
  }
}
