/** 联系方式记录（公开 API 响应） */
export interface ContactMethod {
  id: string
  platform: string
  label: string
  value: string
  linkUrl: string | null
  qrCodeUrl: string | null
  sortOrder: number
}

/** 联系方式记录（管理端 API 响应，含额外字段） */
export interface ContactMethodAdmin extends ContactMethod {
  enabled: boolean
  qrCodeKey: string | null
  createdAt: string
  updatedAt: string
}
