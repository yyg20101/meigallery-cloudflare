/**
 * 邮件 HTML 模板
 * 所有邮件使用统一的品牌模板，代码中硬编码（不做可视化编辑器）。
 */

import { assertSafeExternalUrl } from '../utils/external-url'

const DEFAULT_EMAIL_SITE_NAME = '图库站'
const BRAND_COLOR = '#111111'
const DEFAULT_SITE_URL = 'https://616618.xyz'

export interface EmailTemplateContext {
  siteName?: string
  siteUrl?: string
}

function resolveEmailContext(context?: EmailTemplateContext) {
  const siteName = sanitizeText(context?.siteName) || DEFAULT_EMAIL_SITE_NAME
  let siteUrl = DEFAULT_SITE_URL

  try {
    siteUrl = assertSafeExternalUrl(String(context?.siteUrl || DEFAULT_SITE_URL)).replace(/\/+$/, '')
  } catch {
    siteUrl = DEFAULT_SITE_URL
  }

  return { siteName, siteUrl }
}

/** 通用邮件外壳 */
function wrapTemplate(title: string, bodyHtml: string, context: ReturnType<typeof resolveEmailContext>): string {
  const safeTitle = escapeHtml(title)
  const safeSiteName = escapeHtml(context.siteName)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${safeTitle}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <!-- 头部 -->
          <tr>
            <td style="background:${BRAND_COLOR};padding:24px 32px;text-align:center;">
              <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:1px;">${safeSiteName}</span>
            </td>
          </tr>
          <!-- 正文 -->
          <tr>
            <td style="padding:32px;">
              ${bodyHtml}
            </td>
          </tr>
          <!-- 底部 -->
          <tr>
            <td style="padding:16px 32px;background:#fafafa;border-top:1px solid #eee;text-align:center;">
              <p style="margin:0;font-size:12px;color:#999;">
                此邮件由 <a href="${context.siteUrl}" style="color:#666;text-decoration:none;">${safeSiteName}</a> 自动发送，请勿直接回复。
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

function sanitizeText(value: unknown): string {
  let result = ''
  for (const char of String(value ?? '')) {
    const code = char.charCodeAt(0)
    result += code <= 0x1f || code === 0x7f ? ' ' : char
  }
  return result.replace(/\s+/g, ' ').trim()
}

function escapeHtml(value: unknown): string {
  return sanitizeText(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      case "'": return '&#39;'
      default: return char
    }
  })
}

function safeEmailUrl(value: unknown, fallback: string | null, siteUrl: string): string | null {
  const raw = String(value ?? '').trim()
  if (!raw || hasWhitespaceOrControlCharacter(raw) || hasEncodedWhitespaceOrControlCharacter(raw)) {
    return fallback
  }

  try {
    const candidate = raw.startsWith('/') ? new URL(raw, siteUrl).toString() : raw
    return assertSafeExternalUrl(candidate)
  } catch {
    return fallback
  }
}

function hasEncodedWhitespaceOrControlCharacter(value: string) {
  return /%(?:0[0-9a-f]|1[0-9a-f]|20|7f)/i.test(value)
}

function hasWhitespaceOrControlCharacter(value: string) {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code <= 0x20 || code === 0x7f) return true
  }
  return false
}

/** 邮件模板集合 */
export const emailTemplates = {
  /** 注册验证码 */
  registrationCode(code: string, templateContext?: EmailTemplateContext) {
    const context = resolveEmailContext(templateContext)
    const safeCode = sanitizeText(code)
    const subject = `[${context.siteName}] 你的注册验证码：${safeCode}`
    const html = wrapTemplate(subject, `
      <h2 style="margin:0 0 16px;font-size:18px;color:${BRAND_COLOR};">注册验证码</h2>
      <p style="margin:0 0 24px;font-size:14px;color:#333;line-height:1.6;">
        你正在注册 ${escapeHtml(context.siteName)} 账号，请输入以下验证码完成注册：
      </p>
      <div style="text-align:center;margin:0 0 24px;">
        <span style="display:inline-block;padding:12px 32px;background:#f0f0f0;border-radius:8px;font-size:32px;font-weight:700;letter-spacing:6px;color:${BRAND_COLOR};">
          ${escapeHtml(safeCode)}
        </span>
      </div>
      <p style="margin:0;font-size:13px;color:#888;line-height:1.6;">
        验证码 10 分钟内有效。如果你没有进行此操作，请忽略此邮件。
      </p>
    `, context)
    const text = `[${context.siteName}] 你的注册验证码：${safeCode}（10 分钟内有效）`
    return { subject, html, text }
  },

  /** 密码重置验证码 */
  passwordResetCode(code: string, templateContext?: EmailTemplateContext) {
    const context = resolveEmailContext(templateContext)
    const safeCode = sanitizeText(code)
    const subject = `[${context.siteName}] 密码重置验证码`
    const html = wrapTemplate(subject, `
      <h2 style="margin:0 0 16px;font-size:18px;color:${BRAND_COLOR};">密码重置</h2>
      <p style="margin:0 0 24px;font-size:14px;color:#333;line-height:1.6;">
        你正在重置 ${escapeHtml(context.siteName)} 账号密码，请输入以下验证码：
      </p>
      <div style="text-align:center;margin:0 0 24px;">
        <span style="display:inline-block;padding:12px 32px;background:#f0f0f0;border-radius:8px;font-size:32px;font-weight:700;letter-spacing:6px;color:${BRAND_COLOR};">
          ${escapeHtml(safeCode)}
        </span>
      </div>
      <p style="margin:0;font-size:13px;color:#888;line-height:1.6;">
        验证码 10 分钟内有效。如果你没有请求重置密码，可能有人在尝试访问你的账号，请确保密码安全。
      </p>
    `, context)
    const text = `[${context.siteName}] 密码重置验证码：${safeCode}（10 分钟内有效）`
    return { subject, html, text }
  },

  /** 会员到期提醒 */
  membershipExpiry(levelName: string, expiresAt: string, templateContext?: EmailTemplateContext) {
    const context = resolveEmailContext(templateContext)
    const safeLevelName = sanitizeText(levelName)
    const expiryDate = sanitizeText(expiresAt).split('T')[0] || '未知日期'
    const subject = `[${context.siteName}] 你的${safeLevelName}会员即将到期`
    const html = wrapTemplate(subject, `
      <h2 style="margin:0 0 16px;font-size:18px;color:${BRAND_COLOR};">会员到期提醒</h2>
      <p style="margin:0 0 16px;font-size:14px;color:#333;line-height:1.6;">
        你的 <strong>${escapeHtml(safeLevelName)}</strong> 会员将于 <strong>${escapeHtml(expiryDate)}</strong> 到期。
      </p>
      <p style="margin:0 0 24px;font-size:14px;color:#333;line-height:1.6;">
        到期后你将无法访问对应等级的独家内容。如需续费，请联系站长。
      </p>
      <div style="text-align:center;margin:0 0 16px;">
        <a href="${context.siteUrl}" style="display:inline-block;padding:10px 28px;background:${BRAND_COLOR};color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">
          访问 ${escapeHtml(context.siteName)}
        </a>
      </div>
    `, context)
    const text = `[${context.siteName}] 你的${safeLevelName}会员将于 ${expiryDate} 到期，如需续费请联系站长。`
    return { subject, html, text }
  },

  /** 新图库发布通知 */
  newGallery(title: string, galleryUrl: string, coverUrl?: string, templateContext?: EmailTemplateContext) {
    const context = resolveEmailContext(templateContext)
    const safeTitle = sanitizeText(title)
    const safeGalleryUrl = safeEmailUrl(galleryUrl, context.siteUrl, context.siteUrl)!
    const safeCoverUrl = safeEmailUrl(coverUrl, null, context.siteUrl)
    const subject = `[${context.siteName}] 新内容发布：${safeTitle}`
    const coverHtml = safeCoverUrl
      ? `<div style="margin:0 0 24px;text-align:center;">
          <img src="${safeCoverUrl}" alt="${escapeHtml(safeTitle)}" style="max-width:100%;border-radius:8px;"/>
        </div>`
      : ''
    const html = wrapTemplate(subject, `
      <h2 style="margin:0 0 16px;font-size:18px;color:${BRAND_COLOR};">新内容发布</h2>
      <p style="margin:0 0 16px;font-size:14px;color:#333;line-height:1.6;">
        <strong>${escapeHtml(safeTitle)}</strong> 已上线，快来看看吧！
      </p>
      ${coverHtml}
      <div style="text-align:center;margin:0 0 24px;">
        <a href="${safeGalleryUrl}" style="display:inline-block;padding:10px 28px;background:${BRAND_COLOR};color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">
          立即查看
        </a>
      </div>
      <p style="margin:0;font-size:12px;color:#999;line-height:1.6;">
        不想再收到此类通知？请在 <a href="${context.siteUrl}/settings" style="color:#666;">个人设置</a> 中关闭。
      </p>
    `, context)
    const text = `[${context.siteName}] 新内容发布：${safeTitle} — ${safeGalleryUrl}`
    return { subject, html, text }
  },
}
