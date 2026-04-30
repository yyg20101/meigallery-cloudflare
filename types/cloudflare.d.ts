/**
 * Cloudflare 环境类型定义
 * 通过 event.context.cloudflare.env 访问
 */

export interface CloudflareEnv {
  /** D1 数据库 */
  DB: D1Database
  /** R2 存储桶 */
  R2: R2Bucket
}

/**
 * D1Database 类型（Cloudflare Workers Types 补充）
 */
interface D1Database {
  prepare(query: string): D1PreparedStatement
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
  exec(query: string): Promise<D1ExecResult>
  dump(): Promise<ArrayBuffer>
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = unknown>(colName?: string): Promise<T | null>
  run<T = unknown>(): Promise<D1Result<T>>
  all<T = unknown>(): Promise<D1Result<T>>
  raw<T = unknown>(options?: { columnNames?: boolean }): Promise<T[]>
}

interface D1Result<T = unknown> {
  results: T[]
  success: boolean
  meta: {
    duration: number
    rows_read: number
    rows_written: number
    last_row_id: number
    changed_db: boolean
    changes: number
    size_after: number
  }
}

interface D1ExecResult {
  count: number
  duration: number
}

/**
 * R2 类型补充
 */
interface R2Bucket {
  head(key: string): Promise<R2Object | null>
  get(key: string): Promise<R2ObjectBody | null>
  put(key: string, value: ReadableStream | ArrayBuffer | string, options?: R2PutOptions): Promise<R2Object>
  delete(key: string | string[]): Promise<void>
  list(options?: R2ListOptions): Promise<R2Objects>
}

interface R2Object {
  key: string
  version: string
  size: number
  etag: string
  httpEtag: string
  httpMetadata?: R2HTTPMetadata
  customMetadata?: Record<string, string>
}

interface R2ObjectBody extends R2Object {
  body: ReadableStream
  bodyUsed: boolean
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
  json<T>(): Promise<T>
}

interface R2PutOptions {
  httpMetadata?: R2HTTPMetadata
  customMetadata?: Record<string, string>
}

interface R2HTTPMetadata {
  contentType?: string
  contentLanguage?: string
  contentDisposition?: string
  contentEncoding?: string
  cacheControl?: string
  cacheExpiry?: Date
}

interface R2ListOptions {
  limit?: number
  prefix?: string
  cursor?: string
  delimiter?: string
  include?: ('httpMetadata' | 'customMetadata')[]
}

interface R2Objects {
  objects: R2Object[]
  truncated: boolean
  cursor?: string
  delimitedPrefixes: string[]
}
