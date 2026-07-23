import { deleteCookie } from 'hono/cookie'

export const AD_ATTRIBUTION_CONTEXT_COOKIE = 'mei_ad_attribution'

export function clearAdAttributionContextCookie(c: Parameters<typeof deleteCookie>[0]) {
  deleteCookie(c, AD_ATTRIBUTION_CONTEXT_COOKIE, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
  })
}
