import { describe, expect, it } from 'vitest'
import { resolveAdminImportErrorReportUrl } from './adminDownloadSecurity'

describe('adminDownloadSecurity', () => {
  it('生成编码后的后台导入错误报告下载地址', () => {
    expect(resolveAdminImportErrorReportUrl(' imp_mi123abc ')).toBe('/api/admin/import-jobs/imp_mi123abc/errors')
    expect(resolveAdminImportErrorReportUrl('job_mi123abc')).toBe('/api/admin/import-jobs/job_mi123abc/errors')
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
      expect(resolveAdminImportErrorReportUrl(jobId)).toBe('')
    }
  })
})
