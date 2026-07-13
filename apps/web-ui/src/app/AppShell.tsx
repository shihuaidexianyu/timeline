import type { ReactNode } from 'react'
import { PAGE_ITEMS, pageMeta, type AppPage } from './page-route'

export function AppShell(props: {
  page: AppPage
  selectedDate: string
  timezone: string
  serviceError: string | null
  lastUpdatedAt: string | null
  onPageChange: (page: AppPage) => void
  onPreviousDate: () => void
  onNextDate: () => void
  onToday: () => void
  onDateChange: (date: string) => void
  showPrivacyIntro: boolean
  onDismissPrivacyIntro: () => void
  onOpenPrivacySettings: () => void
  children: ReactNode
}) {
  const pageInfo = pageMeta(props.page)

  return (
    <main className="app-shell app-layout">
      <aside className="sidebar-shell">
        <div className="sidebar-brand">
          <strong>TimeLine</strong>
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
            <h1 className="page-title">{pageInfo.title}</h1>
            <p className="hero-text">{pageInfo.description}</p>
          </div>
          <div className="activity-meta">
            <div className="date-navigation" aria-label="日期导航">
              <button type="button" onClick={props.onPreviousDate} aria-label="前一天">‹</button>
              <input
                type="date"
                aria-label="选择日期"
                value={/^\d{4}-\d{2}-\d{2}$/.test(props.selectedDate) ? props.selectedDate : ''}
                onChange={(event) => event.target.value && props.onDateChange(event.target.value)}
              />
              <button type="button" onClick={props.onToday}>今天</button>
              <button type="button" onClick={props.onNextDate} aria-label="后一天">›</button>
            </div>
            <span>
              <strong>时区</strong>
              {props.timezone}
            </span>
          </div>
        </header>

        {props.showPrivacyIntro ? (
          <section className="privacy-intro" aria-labelledby="privacy-intro-title">
            <div>
              <p className="eyebrow">首次使用</p>
              <h2 id="privacy-intro-title">先确认本地记录范围</h2>
              <ul>
                <li><strong>窗口标题</strong>可能包含文件名，默认记录，可随时关闭。</li>
                <li><strong>页面标题</strong>可能包含网页内容摘要，新安装默认不记录。</li>
                <li><strong>域名</strong>只保存 hostname，例如 example.com，不保存完整 URL 参数。</li>
              </ul>
            </div>
            <div className="privacy-intro-actions">
              <button type="button" onClick={props.onOpenPrivacySettings}>查看隐私设置</button>
              <button type="button" className="is-primary" onClick={props.onDismissPrivacyIntro}>知道了</button>
            </div>
          </section>
        ) : null}

        {props.children}
      </section>
    </main>
  )
}
