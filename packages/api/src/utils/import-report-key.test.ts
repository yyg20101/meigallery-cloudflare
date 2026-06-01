import { describe, expect, it } from 'vitest'
import { isExpectedImportErrorReportKey } from './import-report-key'

describe('导入错误报告 R2 key 工具', () => {
  it('校验错误报告 R2 key 必须属于当前导入任务', () => {
    expect(isExpectedImportErrorReportKey('imports/imp_1/errors.csv', 'imp_1')).toBe(true)
    expect(isExpectedImportErrorReportKey('IMPORTS/imp_1/errors.csv', 'imp_1')).toBe(true)
    expect(isExpectedImportErrorReportKey('imports/imp_2/errors.csv', 'imp_1')).toBe(false)
    expect(isExpectedImportErrorReportKey('imports/imp_1/source.zip', 'imp_1')).toBe(false)
    expect(isExpectedImportErrorReportKey('imports/imp_1/../imp_2/errors.csv', 'imp_1')).toBe(false)
    expect(isExpectedImportErrorReportKey('cases/imp_1/errors.csv', 'imp_1')).toBe(false)
  })
})
