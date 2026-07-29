import { isMarketingTrackingRoute } from '~/utils/marketingTrackingRoute'

export default defineNuxtPlugin(async () => {
  const route = useRoute()
  if (!isMarketingTrackingRoute(route.fullPath)) return
  await useAdAttribution().resolve(route)
})
