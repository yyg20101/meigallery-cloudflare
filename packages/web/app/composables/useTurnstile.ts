type TurnstileInstance = {
  render: (container: string | HTMLElement, options: Record<string, unknown>) => string
  reset: (widgetId?: string) => void
  remove?: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileInstance
  }
}

let turnstileScriptPromise: Promise<void> | null = null

function loadTurnstileScript(): Promise<void> {
  if (import.meta.server) return Promise.resolve()
  if (window.turnstile) return Promise.resolve()
  if (turnstileScriptPromise) return turnstileScriptPromise

  turnstileScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src*="challenges.cloudflare.com/turnstile"]')
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('Turnstile 脚本加载失败')), { once: true })
      if (window.turnstile) resolve()
      return
    }

    const script = document.createElement('script')
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    script.async = true
    script.defer = true
    script.addEventListener('load', () => resolve(), { once: true })
    script.addEventListener('error', () => reject(new Error('Turnstile 脚本加载失败')), { once: true })
    document.head.appendChild(script)
  })

  return turnstileScriptPromise
}

export function useTurnstile(options: {
  containerId: string
  onError?: (message: string) => void
}) {
  const config = useRuntimeConfig()
  const turnstileToken = ref('')
  const turnstileExpired = ref(false)
  const widgetId = ref<string | null>(null)

  const turnstileSiteKey = computed(() => config.public.turnstileSiteKey as string)
  const hasTurnstile = computed(() => !!turnstileSiteKey.value)
  const canSubmit = computed(() => {
    if (!hasTurnstile.value) return true
    return !!turnstileToken.value && !turnstileExpired.value
  })

  async function mountTurnstile() {
    if (import.meta.server || !hasTurnstile.value) return

    await nextTick()
    try {
      await loadTurnstileScript()
      const container = document.getElementById(options.containerId)
      if (!container || !window.turnstile) return

      if (widgetId.value && window.turnstile.remove) {
        window.turnstile.remove(widgetId.value)
      }
      container.innerHTML = ''
      widgetId.value = window.turnstile.render(container, {
        sitekey: turnstileSiteKey.value,
        theme: 'light',
        language: 'zh-cn',
        callback: (token: string) => {
          turnstileToken.value = token
          turnstileExpired.value = false
        },
        'expired-callback': () => {
          turnstileToken.value = ''
          turnstileExpired.value = true
        },
        'error-callback': () => {
          turnstileToken.value = ''
          options.onError?.('人机验证加载失败，请刷新页面重试')
        },
      })
    } catch {
      turnstileToken.value = ''
      options.onError?.('人机验证加载失败，请刷新页面重试')
    }
  }

  function resetTurnstile() {
    turnstileToken.value = ''
    turnstileExpired.value = false
    if (!hasTurnstile.value) return
    if (widgetId.value && window.turnstile?.reset) {
      window.turnstile.reset(widgetId.value)
      return
    }
    void mountTurnstile()
  }

  function cleanupTurnstile() {
    if (widgetId.value && window.turnstile?.remove) {
      window.turnstile.remove(widgetId.value)
    }
    widgetId.value = null
    turnstileToken.value = ''
  }

  return {
    turnstileToken,
    turnstileExpired,
    turnstileSiteKey,
    hasTurnstile,
    canSubmit,
    mountTurnstile,
    resetTurnstile,
    cleanupTurnstile,
  }
}
