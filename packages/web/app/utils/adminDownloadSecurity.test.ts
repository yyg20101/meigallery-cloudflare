import { describe, expect, it } from 'vitest'
import { resolveAdminImportErrorReportUrl } from './adminDownloadSecurity'

describe('adminDownloadSecurity', () => {
  it('生成编码后的后台导入错误报告下载地址', () => {
    expect(resolveAdminImportErrorReportUrl(' imp_mi123abc ', 'https://api.example.com/')).toBe(
      'https://api.example.com/api/admin/import-jobs/imp_mi123abc/errors',
    )
    expect(resolveAdminImportErrorReportUrl('job_mi123abc', 'http://localhost:8787')).toBe(
      'http://localhost:8787/api/admin/import-jobs/job_mi123abc/errors',
    )
  })

  it('拒绝异常任务 ID 和不安全 API 基地址', () => {
    for (const jobId of [
      '',
      '../imp_1',
      'imp_1/errors',
      'imp_1?download=1',
      'imp_1#frag',
      'imp_1%2ferrors',
      'imp_1 space',
    ]) {
      expect(resolveAdminImportErrorReportUrl(jobId, 'https://api.example.com')).toBe('')
    }

    for (const baseURL of [
      '',
      'javascript:alert(1)',
      'https://user:pass@api.example.com',
      'https://api.example.com\\@evil.test',
      'https://api.example.com/%5Cevil',
      'https://api.example.com/\nnext',
    ]) {
      expect(resolveAdminImportErrorReportUrl('imp_mi123abc', baseURL)).toBe('')
    }
  })
})
