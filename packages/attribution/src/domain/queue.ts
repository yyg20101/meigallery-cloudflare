import type {
  AttributionProvider,
} from '@meigallery/shared'

export interface AttributionQueueMessage {
  schemaVersion: 1
  provider: AttributionProvider
  deliveryId: string
}
