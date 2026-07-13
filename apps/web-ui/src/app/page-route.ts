import { useEffect, useState } from 'react'

export const PAGE_ITEMS = [
  { id: 'stats', label: '统计' },
  { id: 'timeline', label: '时间线' },
  { id: 'settings', label: '设置' },
] as const

export type AppPage = (typeof PAGE_ITEMS)[number]['id']

export function useHashRoute(): [AppPage, (page: AppPage) => void, string] {
  const [route, setRoute] = useState(() => ({
    page: pageFromHash(window.location.hash),
    hash: window.location.hash,
  }))

  useEffect(() => {
    if (!window.location.hash) {
      window.location.hash = '#/stats'
    }

    function handleHashChange() {
      setRoute({ page: pageFromHash(window.location.hash), hash: window.location.hash })
    }

    window.addEventListener('hashchange', handleHashChange)
    return () => {
      window.removeEventListener('hashchange', handleHashChange)
    }
  }, [])

  return [
    route.page,
    (nextPage) => {
      const date = dateFromHash(window.location.hash)
      window.location.hash = buildHash(nextPage, date)
      setRoute({ page: nextPage, hash: window.location.hash })
    },
    route.hash,
  ]
}

export function pageFromHash(hash: string): AppPage {
  const normalized = hash.replace(/^#\/?/, '').split('?')[0]
  if (normalized === 'timeline' || normalized === 'settings' || normalized === 'stats') {
    return normalized
  }
  return 'stats'
}

export function dateFromHash(hash: string): string | null {
  const query = hash.split('?')[1]
  if (!query) return null
  const value = new URLSearchParams(query).get('date')
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

export function setHashDate(page: AppPage, date: string) {
  window.location.hash = buildHash(page, date)
}

export function replaceHashDate(page: AppPage, date: string) {
  const nextHash = buildHash(page, date)
  window.history.replaceState(null, '', nextHash)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

function buildHash(page: AppPage, date: string | null) {
  return date ? `#/${page}?date=${encodeURIComponent(date)}` : `#/${page}`
}

export function pageMeta(page: AppPage) {
  if (page === 'timeline') {
    return {
      kicker: '时间线',
      title: '时间线',
      description: '查看当前窗口内的事件分布与进程记录。',
    }
  }

  if (page === 'settings') {
    return {
      kicker: '设置',
      title: '本地设置',
      description: '查看当前连接、本地采集范围和运行配置。',
    }
  }

  return {
    kicker: '统计',
    title: '统计概览',
    description: '按天查看应用使用、状态分布和周期变化。',
  }
}
