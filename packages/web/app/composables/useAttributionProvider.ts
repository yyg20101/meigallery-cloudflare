import type { AttributionPlatformProvider } from '~/utils/attributionPlatforms'
import { normalizeAttributionPlatformProvider } from '~/utils/attributionPlatforms'

export function useAttributionProvider() {
  const route = useRoute()
  const router = useRouter()
  const provider = ref<AttributionPlatformProvider>(normalizeAttributionPlatformProvider(route.query.provider))

  watch(() => route.query.provider, async (value) => {
    provider.value = normalizeAttributionPlatformProvider(value)
    if (value === provider.value) return
    await router.replace({ query: { ...route.query, provider: provider.value } })
  }, { immediate: true })

  watch(provider, async (value) => {
    if (route.query.provider === value) return
    await router.replace({ query: { ...route.query, provider: value } })
  })

  return provider
}
