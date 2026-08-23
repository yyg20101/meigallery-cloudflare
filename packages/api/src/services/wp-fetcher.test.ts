import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAllCategories, fetchAllPosts, fetchAllTags } from './wp-fetcher'

afterEach(() => {
  vi.restoreAllMocks()
})

function validPost() {
  return {
    id: 1,
    date: '2026-08-20T08:00:00.000Z',
    slug: 'gallery-one',
    link: 'https://legacy.example.com/gallery/gallery-one/',
    title: { rendered: '图库一' },
    content: { rendered: '<p>正文</p>' },
    featured_media: 0,
    categories: [1],
    tags: [2],
  }
}

describe('WordPress REST 拉取完整性', () => {
  it('分类接口失败时终止任务，不把失败静默降级为空标签', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('暂时不可用', { status: 503, statusText: 'Service Unavailable' }),
    )

    await expect(fetchAllCategories('https://legacy.example.com')).rejects.toThrow(
      'WP 分类 API 请求失败: 503 Service Unavailable',
    )
  })

  it('权威分页超过安全上限时拒绝部分导入', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([validPost()]), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'X-WP-TotalPages': '101',
        'X-WP-Total': '5050',
      },
    }))

    await expect(fetchAllPosts({
      baseUrl: 'https://legacy.example.com',
      perPage: 50,
      maxPages: 100,
    })).rejects.toThrow('WP API 页数 101 超过安全上限 100')
  })

  it('拒绝结构不完整的文章数组', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([{ id: 1 }]), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'X-WP-TotalPages': '1',
        'X-WP-Total': '1',
      },
    }))

    await expect(fetchAllPosts({
      baseUrl: 'https://legacy.example.com',
    })).rejects.toThrow('WP 文章响应格式不正确')
  })

  it('每一页完成完整性校验后同步等待运行租约心跳', async () => {
    const secondPost = { ...validPost(), id: 2, slug: 'gallery-two' }
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify([validPost()]), {
        status: 200,
        headers: { 'X-WP-TotalPages': '2', 'X-WP-Total': '2' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([secondPost]), {
        status: 200,
        headers: { 'X-WP-TotalPages': '2', 'X-WP-Total': '2' },
      }))
    const progress: string[] = []

    const result = await fetchAllPosts({
      baseUrl: 'https://legacy.example.com',
      perPage: 1,
      onPage: async event => {
        progress.push(`${event.resource}:${event.page}/${event.totalPages}:${event.itemCount}`)
      },
    })

    expect(result.posts).toHaveLength(2)
    expect(progress).toEqual(['posts:1/2:1', 'posts:2/2:2'])
  })

  it('分页总页数在读取期间漂移时拒绝形成部分导入', async () => {
    const secondPost = { ...validPost(), id: 2, slug: 'gallery-two' }
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify([validPost()]), {
        status: 200,
        headers: { 'X-WP-TotalPages': '2', 'X-WP-Total': '2' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([secondPost]), {
        status: 200,
        headers: { 'X-WP-TotalPages': '1', 'X-WP-Total': '2' },
      }))

    await expect(fetchAllPosts({
      baseUrl: 'https://legacy.example.com',
      perPage: 1,
    })).rejects.toThrow('WP API 文章总页数在分页过程中发生变化，请重新执行')
  })

  it('每个远程分页请求都携带 60 秒截止信号', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([validPost()]), {
        status: 200,
        headers: { 'X-WP-TotalPages': '1', 'X-WP-Total': '1' },
      }),
    )

    await fetchAllPosts({ baseUrl: 'https://legacy.example.com' })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'manual',
      signal: expect.any(AbortSignal),
    })
  })

  it('空分类和标签页也报告进度，避免空站点执行期间漏续租', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('[]', {
      status: 200,
      headers: { 'X-WP-TotalPages': '1', 'X-WP-Total': '0' },
    }))
    const progress: string[] = []
    const onPage = async (event: { resource: string; page: number; itemCount: number }) => {
      progress.push(`${event.resource}:${event.page}:${event.itemCount}`)
    }

    await expect(fetchAllCategories('https://legacy.example.com', onPage)).resolves.toEqual([])
    await expect(fetchAllTags('https://legacy.example.com', onPage)).resolves.toEqual([])
    expect(progress).toEqual(['categories:1:0', 'tags:1:0'])
  })

  it('流式读取时在实际正文超过 16 MiB 后取消响应，不先整体缓冲', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    let emitted = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted++
        controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'X-WP-TotalPages': '1',
        'X-WP-Total': '1',
      },
    }))

    await expect(fetchAllPosts({
      baseUrl: 'https://legacy.example.com',
    })).rejects.toThrow('WP 文章响应超过 16 MiB 安全上限')
    expect(emitted).toBeGreaterThanOrEqual(17)
    expect(emitted).toBeLessThanOrEqual(18)
    expect(cancelled).toBe(true)
  })
})
