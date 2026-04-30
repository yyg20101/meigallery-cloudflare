/**
 * 邮件 HTML 模板
 * 所有邮件使用统一的品牌模板，代码中硬编码（不做可视化编辑器）。
 */

const SITE_NAME = 'MeiGallery'
const BRAND_COLOR = '#111111'
const SITE_URL = 'https://616618.xyz'

/** 通用邮件外壳 */
function wrapTemplate(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <!-- 头部 -->
          <tr>
            <td style="background:${BRAND_COLOR};padding:24px 32px;text-align:center;">
              <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:1px;">${SITE_NAME}</span>
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
                此邮件由 <a href="${SITE_URL}" style="color:#666;text-decoration:none;">${SITE_NAME}</a> 自动发送，请勿直接回复。
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

/** 邮件模板集合 */
export const emailTemplates = {
  /** 注册验证码 */
  registrationCode(code: string) {
    const subject = `[${SITE_NAME}] 你的注册验证码：${code}`
    const html = wrapTemplate(subject, `
      <h2 style="margin:0 0 16px;font-size:18px;color:${BRAND_COLOR};">注册验证码</h2>
      <p style="margin:0 0 24px;font-size:14px;color:#333;line-height:1.6;">
        你正在注册 ${SITE_NAME} 账号，请输入以下验证码完成注册：
      </p>
      <div style="text-align:center;margin:0 0 24px;">
        <span style="display:inline-block;padding:12px 32px;background:#f0f0f0;border-radius:8px;font-size:32px;font-weight:700;letter-spacing:6px;color:${BRAND_COLOR};">
          ${code}
        </span>
      </div>
      <p style="margin:0;font-size:13px;color:#888;line-height:1.6;">
        验证码 10 分钟内有效。如果你没有进行此操作，请忽略此邮件。
      </p>
    `)
    const text = `[${SITE_NAME}] 你的注册验证码：${code}（10 分钟内有效）`
    return { subject, html, text }
  },

  /** 密码重置验证码 */
  passwordResetCode(code: string) {
    const subject = `[${SITE_NAME}] 密码重置验证码`
    const html = wrapTemplate(subject, `
      <h2 style="margin:0 0 16px;font-size:18px;color:${BRAND_COLOR};">密码重置</h2>
      <p style="margin:0 0 24px;font-size:14px;color:#333;line-height:1.6;">
        你正在重置 ${SITE_NAME} 账号密码，请输入以下验证码：
      </p>
      <div style="text-align:center;margin:0 0 24px;">
        <span style="display:inline-block;padding:12px 32px;background:#f0f0f0;border-radius:8px;font-size:32px;font-weight:700;letter-spacing:6px;color:${BRAND_COLOR};">
          ${code}
        </span>
      </div>
      <p style="margin:0;font-size:13px;color:#888;line-height:1.6;">
        验证码 10 分钟内有效。如果你没有请求重置密码，可能有人在尝试访问你的账号，请确保密码安全。
      </p>
    `)
    const text = `[${SITE_NAME}] 密码重置验证码：${code}（10 分钟内有效）`
    return { subject, html, text }
  },

  /** 会员到期提醒 */
  membershipExpiry(levelName: string, expiresAt: string) {
    const expiryDate = expiresAt.split('T')[0]
    const subject = `[${SITE_NAME}] 你的${levelName}会员即将到期`
    const html = wrapTemplate(subject, `
      <h2 style="margin:0 0 16px;font-size:18px;color:${BRAND_COLOR};">会员到期提醒</h2>
      <p style="margin:0 0 16px;font-size:14px;color:#333;line-height:1.6;">
        你的 <strong>${levelName}</strong> 会员将于 <strong>${expiryDate}</strong> 到期。
      </p>
      <p style="margin:0 0 24px;font-size:14px;color:#333;line-height:1.6;">
        到期后你将无法访问对应等级的独家内容。如需续费，请联系站长。
      </p>
      <div style="text-align:center;margin:0 0 16px;">
        <a href="${SITE_URL}" style="display:inline-block;padding:10px 28px;background:${BRAND_COLOR};color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">
          访问 ${SITE_NAME}
        </a>
      </div>
    `)
    const text = `[${SITE_NAME}] 你的${levelName}会员将于 ${expiryDate} 到期，如需续费请联系站长。`
    return { subject, html, text }
  },

  /** 新图库发布通知 */
  newGallery(title: string, galleryUrl: string, coverUrl?: string) {
    const subject = `[${SITE_NAME}] 新内容发布：${title}`
    const coverHtml = coverUrl
      ? `<div style="margin:0 0 24px;text-align:center;">
          <img src="${coverUrl}" alt="${title}" style="max-width:100%;border-radius:8px;"/>
        </div>`
      : ''
    const html = wrapTemplate(subject, `
      <h2 style="margin:0 0 16px;font-size:18px;color:${BRAND_COLOR};">新内容发布</h2>
      <p style="margin:0 0 16px;font-size:14px;color:#333;line-height:1.6;">
        <strong>${title}</strong> 已上线，快来看看吧！
      </p>
      ${coverHtml}
      <div style="text-align:center;margin:0 0 24px;">
        <a href="${galleryUrl}" style="display:inline-block;padding:10px 28px;background:${BRAND_COLOR};color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">
          立即查看
        </a>
      </div>
      <p style="margin:0;font-size:12px;color:#999;line-height:1.6;">
        不想再收到此类通知？请在 <a href="${SITE_URL}/settings" style="color:#666;">个人设置</a> 中关闭。
      </p>
    `)
    const text = `[${SITE_NAME}] 新内容发布：${title} — ${galleryUrl}`
    return { subject, html, text }
  },
}
