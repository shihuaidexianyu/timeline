import type { ReactNode } from 'react'
import { PAGE_ITEMS, pageMeta, type AppPage } from './page-route'

export function AppShell(props: {
  page: AppPage
  selectedDate: string
  timezone: string
  serviceError: string | null
  lastUpdatedAt: string | null
  onPageChange: (page: AppPage) => void
  children: ReactNode
}) {
  const pageInfo = pageMeta(props.page)

  return (
    <main className="app-shell app-layout">
      <aside className="sidebar-shell">
        <div className="sidebar-brand">
          <h1>TimeLine</h1>
        </div>

        <nav className="sidebar-nav" aria-label="页面">
          {PAGE_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`sidebar-nav-button ${props.page === item.id ? 'is-active' : ''}`}
              onClick={() => {
                props.onPageChange(item.id)
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-status">
          <span>服务状态</span>
          <strong className={props.serviceError ? 'status-error' : 'status-ok'}>
            {props.serviceError ? '离线' : '在线'}
          </strong>
          <small>
            {props.lastUpdatedAt ? `${props.lastUpdatedAt} 更新` : '等待连接'}
          </small>
        </div>
      </aside>

      <section className="main-shell">
        <header className="page-header">
          <div>
            <p className="eyebrow">{pageInfo.kicker}</p>
            <h2 className="page-title">{pageInfo.title}</h2>
            <p className="hero-text">{pageInfo.description}</p>
          </div>
          <div className="activity-meta">
            <span>
              <strong>日期</strong>
              {props.selectedDate}
            </span>
            <span>
              <strong>时区</strong>
              {props.timezone}
            </span>
          </div>
        </header>

        {props.children}
      </section>
    </main>
  )
}
