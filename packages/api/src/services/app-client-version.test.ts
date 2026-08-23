import { describe, expect, it } from 'vitest'
import {
  compareAppNumericVersions,
  normalizeAppNumericVersion,
  supportsAppMinimumVersion,
} from './app-client-version'

describe('App 数字版本比较', () => {
  it('只接受两段或三段数字版本', () => {
    expect(normalizeAppNumericVersion(' 1.25.0 ')).toBe('1.25.0')
    expect(normalizeAppNumericVersion('1.0')).toBe('1.0')
    expect(normalizeAppNumericVersion('1')).toBeNull()
    expect(normalizeAppNumericVersion('1.0-beta')).toBeNull()
    expect(normalizeAppNumericVersion('1.2.3.4')).toBeNull()
  })

  it('把缺失的补丁段按零比较', () => {
    expect(compareAppNumericVersions('1.0', '1.0.0')).toBe(0)
    expect(compareAppNumericVersions('1.10', '1.9.9')).toBe(1)
    expect(compareAppNumericVersions('2.0', '10.0')).toBe(-1)
  })

  it('对非法版本安全拒绝最低版本门禁', () => {
    expect(supportsAppMinimumVersion('1.25.0', '1.20')).toBe(true)
    expect(supportsAppMinimumVersion('1.19.9', '1.20')).toBe(false)
    expect(supportsAppMinimumVersion(undefined, '1.0')).toBe(false)
    expect(supportsAppMinimumVersion('1.0', 'latest')).toBe(false)
  })
})
