import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import GalleryCard from './GalleryCard.vue'

const gallery = {
  id: 'gal_1',
  title: '夏日写真',
  slug: 'summer-portrait',
  coverUrl: '/api/media/asset-1/thumbnail',
  summary: '授权写真内容',
  requiredLevelRank: 10,
  publishedAt: '2026-06-07T10:00:00.000Z',
  tags: [
    { id: 'tag_1', name: '广东', slug: 'guangdong', type: 'region' },
  ],
  viewCount: 12,
  likeCount: 3,
}

const nuxtLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>',
}

const fadeImageStub = {
  props: ['src', 'alt'],
  template: '<img :src="src" :alt="alt" />',
}

describe('GalleryCard', () => {
  const track = vi.fn()

  beforeEach(() => {
    track.mockClear()
    vi.stubGlobal('useAnalytics', () => ({ track }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('点击卡片时只上报图库、列表类型和位置', async () => {
    const wrapper = mount(GalleryCard, {
      props: {
        gallery,
        listType: 'search_results',
        position: 4,
      },
      global: { stubs: { NuxtLink: nuxtLinkStub, FadeImage: fadeImageStub } },
    })

    await wrapper.get('a').trigger('click')

    expect(track).toHaveBeenCalledWith('gallery_card_click', expect.objectContaining({
      entityType: 'gallery',
      entityId: 'gal_1',
      props: {
        gallery_id: 'gal_1',
        list_type: 'search_results',
        position: 4,
      },
    }))
    expect(JSON.stringify(track.mock.calls)).not.toContain('summer-portrait')
  })
})
