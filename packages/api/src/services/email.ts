/**
 * 邮件发送服务
 * 封装 Cloudflare Email Service Worker binding，提供类型安全的邮件发送接口。
 * Beta 期间 API 可能变更，所有发送逻辑集中在此文件便于维护。
 */

import type { Bindings } from '../index'
import { emailTemplates } from './email-templates'
import { DEFAULT_SITE_NAME, LEGACY_DEFAULT_SITE_NAME } from '../utils/public-site-settings'
import { safeSiteTextSetting } from '../utils/site-text-settings'
import { parseStoredSettingValue } from '../utils/stored-setting-value'

/** 邮件发送选项 */
interface SendMailOptions {
  to: string
  subject: string
  html: string
  text: string
}

type EmailEnv = Pick<Bindings, 'EMAIL' | 'EMAIL_FROM' | 'DB' | 'SITE_URL'>

async function resolveTemplateContext(env: Pick<Bindings, 'DB' | 'SITE_URL'>) {
  const row = await env.DB
    .prepare("SELECT value FROM site_settings WHERE key = 'site_name'")
    .first<{ value: string }>()
  const storedSiteName = row ? safeSiteTextSetting('site_name', parseStoredSettingValue(row.value)) : ''
  const siteName = storedSiteName && storedSiteName !== LEGACY_DEFAULT_SITE_NAME ? storedSiteName : DEFAULT_SITE_NAME

  return {
    siteName,
    siteUrl: env.SITE_URL,
  }
}

/**
 * 通过 Cloudflare Email Service binding 发送邮件
 */
export async function sendMail(
  env: Pick<Bindings, 'EMAIL' | 'EMAIL_FROM'>,
  options: SendMailOptions,
): Promise<void> {
  await env.EMAIL.send({
    from: env.EMAIL_FROM,
    to: options.to,
    subject: options.subject,
    html: options.html,
    text: options.text,
  })
}

// ============================================================
// 业务场景快捷方法
// ============================================================

/** 发送注册验证码 */
export async function sendRegistrationCode(
  env: EmailEnv,
  to: string,
  code: string,
): Promise<void> {
  const context = await resolveTemplateContext(env)
  const { subject, html, text } = emailTemplates.registrationCode(code, context)
  await sendMail(env, { to, subject, html, text })
}

/** 发送密码重置验证码 */
export async function sendPasswordResetCode(
  env: EmailEnv,
  to: string,
  code: string,
): Promise<void> {
  const context = await resolveTemplateContext(env)
  const { subject, html, text } = emailTemplates.passwordResetCode(code, context)
  await sendMail(env, { to, subject, html, text })
}

/** 发送会员到期提醒 */
export async function sendMembershipExpiryReminder(
  env: EmailEnv,
  to: string,
  levelName: string,
  expiresAt: string,
): Promise<void> {
  const context = await resolveTemplateContext(env)
  const { subject, html, text } = emailTemplates.membershipExpiry(levelName, expiresAt, context)
  await sendMail(env, { to, subject, html, text })
}

/** 发送新图库通知 */
export async function sendNewGalleryNotification(
  env: EmailEnv,
  to: string,
  galleryTitle: string,
  galleryUrl: string,
  coverUrl?: string,
): Promise<void> {
  const context = await resolveTemplateContext(env)
  const { subject, html, text } = emailTemplates.newGallery(galleryTitle, galleryUrl, coverUrl, context)
  await sendMail(env, { to, subject, html, text })
}
