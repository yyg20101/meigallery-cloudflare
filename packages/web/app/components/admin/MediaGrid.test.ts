import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MediaGrid from './MediaGrid.vue'

describe('MediaGrid', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('后台媒体预览图片走同源代理且不发送来源页', () => {
    const wrapper = mount(MediaGrid, {
      props: {
        galleryId: 'gallery-1',
        coverKey: null,
        loading: false,
        assets: [
          {
            id: 'asset-1',
            galleryId: 'gallery-1',
            type: 'image',
            storage: 'r2',
            r2Key: 'originals/gallery-1/asset-1.jpg',
            streamUid: null,
            requiredRank: 0,
            role: 'content',
            sortOrder: 0,
            uploadStatus: 'completed',
            createdAt: '2026-06-03T00:00:00.000Z',
            thumbnailUrl: '/api/admin/media/asset-1/thumbnail',
          },
        ],
      },
    })

    const img = wrapper.get('img')
    expect(img.attributes('src')).toBe('/api/admin/media/asset-1/thumbnail')
    expect(img.attributes('referrerpolicy')).toBe('no-referrer')
  })
})
