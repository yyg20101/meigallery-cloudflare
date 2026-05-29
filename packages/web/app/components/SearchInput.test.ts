import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SearchInput from './SearchInput.vue'

describe('SearchInput', () => {
  it('提交时发出 trim 后的搜索词', async () => {
    const wrapper = mount(SearchInput, {
      props: { modelValue: '  夏日写真  ' },
    })

    await wrapper.find('form').trigger('submit')

    expect(wrapper.emitted('search')).toEqual([['夏日写真']])
  })

  it('输入内容时发出 v-model 更新事件', async () => {
    const wrapper = mount(SearchInput, {
      props: { modelValue: '' },
    })

    await wrapper.find('input').setValue('清新')

    expect(wrapper.emitted('update:modelValue')).toEqual([['清新']])
  })

  it('默认展示图库搜索占位文案', () => {
    const wrapper = mount(SearchInput)

    expect(wrapper.find('input').attributes('placeholder')).toBe('搜索图库...')
  })
})
