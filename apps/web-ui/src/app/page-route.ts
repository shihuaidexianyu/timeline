import { useEffect, useState } from 'react'

export const PAGE_ITEMS = [
  { id: 'stats', label: '统计' },
  { id: 'timeline', label: '时间线' },
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
      window.location.hash = `#/${nextPage}`
      setPage(nextPage)
    },
  ]
}

export function pageFromHash(hash: string): AppPage {
  const normalized = hash.replace(/^#\/?/, '')
  if (normalized === 'timeline' || normalized === 'settings' || normalized === 'stats') {
    return normalized
  }
  return 'stats'
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
