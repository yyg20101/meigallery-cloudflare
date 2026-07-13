export function isRetryableAdPlatformDeliveryErrorCode(errorCode: string) {
  return errorCode === 'meta_timeout'
    || errorCode === 'meta_network_error'
    || errorCode === 'meta_delivery_state_conflict'
    || errorCode === 'tiktok_timeout'
    || errorCode === 'tiktok_network_error'
    || errorCode === 'tiktok_delivery_state_conflict'
    || errorCode === 'tiktok_code_40016'
    || errorCode === 'tiktok_code_40100'
    || errorCode === 'tiktok_code_40133'
    || errorCode === 'tiktok_code_40202'
    || errorCode === 'tiktok_code_60001'
    || /^(?:meta|tiktok)_http_(?:429|5\d\d)$/.test(errorCode)
    || /^tiktok_code_5\d{4}$/.test(errorCode)
}
