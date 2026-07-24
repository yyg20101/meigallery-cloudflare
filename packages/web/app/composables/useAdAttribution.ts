import type {
  AdBrowserSignal,
} from '@meigallery/shared'
import type {
  AttributionContactInput,
} from '~/plugins/attribution.client'

type BrowserPayload = Record<string, string | number | boolean>

export function useAdAttribution() {
  function client() {
    if (import.meta.server) return null
    return useNuxtApp().$attribution
  }

  async function trackContact(input: AttributionContactInput) {
    return client()?.trackContact(input) ?? null
  }

  async function consumeRegistrationInstruction(
    instructionToken: string | null | undefined,
  ) {
    return client()?.consumeInstructionToken(instructionToken) ?? null
  }

  async function trackSignal(
    signal: AdBrowserSignal,
    payload: BrowserPayload,
  ) {
    return client()?.trackSignal(signal, payload) ?? false
  }

  return {
    trackContact,
    consumeRegistrationInstruction,
    trackSignal,
  }
}
