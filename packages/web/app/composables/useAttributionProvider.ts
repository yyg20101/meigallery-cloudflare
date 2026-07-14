import type { AttributionDashboardProvider } from '~/composables/useAdminAttribution'
import { normalizeAttributionDashboardProvider } from '~/utils/attributionPlatforms'

export function useAttributionProvider() {
  const route = useRoute()
  const router = useRouter()
  const provider = ref<AttributionDashboardProvider>(normalizeAttributionDashboardProvider(route.query.provider))

  watch(() => route.query.provider, async (value) => {
    provider.value = normalizeAttributionDashboardProvider(value)
    if (value === 'meta' || value === 'tiktok') return
    await router.replace({ query: { ...route.query, provider: provider.value } })
  }, { immediate: true })

  watch(provider, async (value) => {
    if (route.query.provider === value) return
    await router.replace({ query: { ...route.query, provider: value } })
  })

  return provider
}
