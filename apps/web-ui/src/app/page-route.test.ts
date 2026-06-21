import { describe, expect, it } from 'vitest'
import { PAGE_ITEMS, pageFromHash, pageMeta } from './page-route'

describe('page route', () => {
  it('routes stats, usage, and settings pages', () => {
    expect(PAGE_ITEMS.map((item) => item.label)).toEqual(['统计', '趋势', '设置'])
    expect(pageFromHash('#/usage')).toBe('usage')
    expect(pageFromHash('#/timeline')).toBe('stats')
    expect(pageMeta('usage').title).toBe('使用趋势')
    expect(pageMeta('stats').title).toBe('统计概览')
  })
})
