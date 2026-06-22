import { useEffect, useState } from 'react'

export const PAGE_ITEMS = [
  { id: 'stats', label: '统计' },
  { id: 'usage', label: '趋势' },
  { id: 'settings', label: '设置' },
] as const

export type AppPage = (typeof PAGE_ITEMS)[number]['id']

export function useHashRoute(): [AppPage, (page: AppPage) => void] {
  const [page, setPage] = useState<AppPage>(() => pageFromHash(window.location.hash))

  useEffect(() => {
    if (!window.location.hash) {
      window.location.hash = '#/stats'
    }

    function handleHashChange() {
      setPage(pageFromHash(window.location.hash))
    }

    window.addEventListener('hashchange', handleHashChange)
    return () => {
      window.removeEventListener('hashchange', handleHashChange)
    }
  }, [])

  return [
    page,
    (nextPage) => {
      const query = parseHashQuery(window.location.hash)
      window.location.hash = `#/${nextPage}${stringifyQuery(query)}`
      setPage(nextPage)
    },
  ]
}

export function pageFromHash(hash: string): AppPage {
  const normalized = hash.replace(/^#\/?/, '').split('?')[0]
  if (normalized === 'settings' || normalized === 'usage' || normalized === 'stats') {
    return normalized
  }
  return 'stats'
}

/// Parses the query string from a hash like `#/stats?date=2026-06-22` into a
/// `Record<string, string>`. Returns an empty object if no query string.
export function parseHashQuery(hash: string): Record<string, string> {
  const questionIndex = hash.indexOf('?')
  if (questionIndex === -1) {
    return {}
  }
  const queryString = hash.slice(questionIndex + 1)
  const params = new URLSearchParams(queryString)
  const result: Record<string, string> = {}
  params.forEach((value, key) => {
    result[key] = value
  })
  return result
}

/// Serializes a query params object back into `?key=value&...` form, or empty
/// string if no params.
export function stringifyQuery(params: Record<string, string>): string {
  const entries = Object.entries(params).filter(([, value]) => value)
  if (entries.length === 0) {
    return ''
  }
  const search = new URLSearchParams(entries)
  return `?${search.toString()}`
}

/// Updates a single query param in the current hash without changing the page.
export function setHashQueryParam(key: string, value: string | null) {
  const page = pageFromHash(window.location.hash)
  const params = parseHashQuery(window.location.hash)
  if (value === null || value === '') {
    delete params[key]
  } else {
    params[key] = value
  }
  window.location.hash = `#/${page}${stringifyQuery(params)}`
}

/// Hook that reads a specific query param from the hash and stays in sync
/// with `hashchange` events.
export function useHashQueryParam(key: string): [string | null, (value: string | null) => void] {
  const [value, setValue] = useState<string | null>(() => {
    const params = parseHashQuery(window.location.hash)
    return params[key] ?? null
  })

  useEffect(() => {
    function handleHashChange() {
      const params = parseHashQuery(window.location.hash)
      setValue(params[key] ?? null)
    }
    window.addEventListener('hashchange', handleHashChange)
    return () => {
      window.removeEventListener('hashchange', handleHashChange)
    }
  }, [key])

  return [
    value,
    (next) => {
      setHashQueryParam(key, next)
      setValue(next)
    },
  ]
}

export function pageMeta(page: AppPage) {
  if (page === 'settings') {
    return {
      kicker: '设置',
      title: '本地设置',
      description: '查看当前连接、本地采集范围和运行配置。',
    }
  }

  if (page === 'usage') {
    return {
      kicker: '趋势',
      title: '使用趋势',
      description: '按周、月查看应用使用变化。',
    }
  }

  return {
    kicker: '统计',
    title: '统计概览',
    description: '按天查看应用使用、状态分布和使用热度。',
  }
}
