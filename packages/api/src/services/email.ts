/**
 * 邮件发送服务
 * 封装 Cloudflare Email Service Worker binding，提供类型安全的邮件发送接口。
 * Beta 期间 API 可能变更，所有发送逻辑集中在此文件便于维护。
 */

import type { Bindings } from '../index'
import { emailTemplates } from './email-templates'

/** 邮件发送选项 */
interface SendMailOptions {
  to: string
  subject: string
  html: string
  text: string
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
  env: Pick<Bindings, 'EMAIL' | 'EMAIL_FROM'>,
  to: string,
  code: string,
): Promise<void> {
  const { subject, html, text } = emailTemplates.registrationCode(code)
  await sendMail(env, { to, subject, html, text })
}

/** 发送密码重置验证码 */
export async function sendPasswordResetCode(
  env: Pick<Bindings, 'EMAIL' | 'EMAIL_FROM'>,
  to: string,
  code: string,
): Promise<void> {
  const { subject, html, text } = emailTemplates.passwordResetCode(code)
  await sendMail(env, { to, subject, html, text })
}

/** 发送会员到期提醒 */
export async function sendMembershipExpiryReminder(
  env: Pick<Bindings, 'EMAIL' | 'EMAIL_FROM'>,
  to: string,
  levelName: string,
  expiresAt: string,
): Promise<void> {
  const { subject, html, text } = emailTemplates.membershipExpiry(levelName, expiresAt)
  await sendMail(env, { to, subject, html, text })
}

/** 发送新图库通知 */
export async function sendNewGalleryNotification(
  env: Pick<Bindings, 'EMAIL' | 'EMAIL_FROM'>,
  to: string,
  galleryTitle: string,
  galleryUrl: string,
  coverUrl?: string,
): Promise<void> {
  const { subject, html, text } = emailTemplates.newGallery(galleryTitle, galleryUrl, coverUrl)
  await sendMail(env, { to, subject, html, text })
}
