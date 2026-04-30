import type { ContactMethod } from '@meigallery/shared'

/**
 * 公开联系方式 composable
 * 从 /api/contact-methods 获取已启用的联系方式
 * SSR 友好，全局缓存
 */
export function useContactMethods() {
  const { api } = useApi()

  const methods = useState<ContactMethod[]>('contact-methods', () => [])
  const loaded = useState<boolean>('contact-methods-loaded', () => false)

  async function fetchContactMethods() {
    if (loaded.value) return methods.value
    try {
      const res = await api<{ data: ContactMethod[] }>('/api/contact-methods')
      methods.value = res.data
      loaded.value = true
    } catch {
      loaded.value = true
    }
    return methods.value
  }

  const hasContactMethods = computed(() => methods.value.length > 0)

  return {
    contactMethods: methods,
    fetchContactMethods,
    hasContactMethods,
  }
}
