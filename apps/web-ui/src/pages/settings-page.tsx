import { useEffect, useState } from 'react'
import {
  API_BASE_URL,
  type AgentSettingsResponse,
  type AppUpdateInfo,
  type UpdateAgentConfigRequest,
} from '../api'
import type { ThemeMode } from '../hooks/use-theme'
import { clampNumber, parseConfigList } from '../lib/dashboard-helpers'

export function SettingsPage(props: {
  agentSettings: AgentSettingsResponse | null
  loading: boolean
  error: string | null
  settingsError: string | null
  settingsNotice: string | null
  updateInfo: AppUpdateInfo | null
  updateError: string | null
  updateNotice: string | null
  lastUpdatedAt: string | null
  selectedDate: string
  timezone: string
  savingAutostart: boolean
  savingConfig: boolean
  isSettingsRefreshing: boolean
  checkingUpdate: boolean
  installingUpdate: boolean
  theme: ThemeMode
  onChangeTheme: (theme: ThemeMode) => void
  onToggleAutostart: (enabled: boolean) => Promise<void>
  onUpdateConfig: (payload: UpdateAgentConfigRequest) => Promise<void>
  onCheckUpdate: () => Promise<void>
  onInstallUpdate: () => Promise<void>
}) {
  const [idleThresholdSecs, setIdleThresholdSecs] = useState(60)
  const [pollIntervalMillis, setPollIntervalMillis] = useState(1000)
  const [healthReminderEnabled, setHealthReminderEnabled] = useState(true)
  const [healthReminderThresholdSecs, setHealthReminderThresholdSecs] = useState(3000)
  const [recordWindowTitles, setRecordWindowTitles] = useState(true)
  const [recordPageTitles, setRecordPageTitles] = useState(true)
  const [ignoredAppsText, setIgnoredAppsText] = useState('')
  const [ignoredDomainsText, setIgnoredDomainsText] = useState('')

  useEffect(() => {
    if (!props.agentSettings) {
      return
    }

    // Keep the editable local form in sync when async settings arrive from the agent.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIdleThresholdSecs(
      Number.isFinite(props.agentSettings.idle_threshold_secs)
        ? props.agentSettings.idle_threshold_secs
        : 300,
    )
    setPollIntervalMillis(
      Number.isFinite(props.agentSettings.poll_interval_millis)
        ? props.agentSettings.poll_interval_millis
        : 1000,
    )
    setHealthReminderEnabled(Boolean(props.agentSettings.health_reminder_enabled))
    setHealthReminderThresholdSecs(
      Number.isFinite(props.agentSettings.health_reminder_threshold_secs)
        ? props.agentSettings.health_reminder_threshold_secs
        : 3000,
    )
    setRecordWindowTitles(Boolean(props.agentSettings.record_window_titles))
    setRecordPageTitles(Boolean(props.agentSettings.record_page_titles))
    setIgnoredAppsText(
      Array.isArray(props.agentSettings.ignored_apps)
        ? props.agentSettings.ignored_apps.join('\n')
        : '',
    )
    setIgnoredDomainsText(
      Array.isArray(props.agentSettings.ignored_domains)
        ? props.agentSettings.ignored_domains.join('\n')
        : '',
    )
  }, [props.agentSettings])

  async function handleSaveConfig() {
    await props.onUpdateConfig({
      idle_threshold_secs: clampNumber(Math.round(idleThresholdSecs), 15, 1800),
      poll_interval_millis: clampNumber(Math.round(pollIntervalMillis), 250, 5000),
      health_reminder_enabled: healthReminderEnabled,
      health_reminder_threshold_secs: clampNumber(
        Math.round(healthReminderThresholdSecs),
        300,
        21600,
      ),
      record_window_titles: recordWindowTitles,
      record_page_titles: recordPageTitles,
      ignored_apps: parseConfigList(ignoredAppsText),
      ignored_domains: parseConfigList(ignoredDomainsText),
    })
  }

  return (
    <section className="page-stack">
      <div className="page-content-layout">
        <div className="page-content-main page-card-stack">
          <div className="panel page-panel settings-card">
            <div className="panel-header">
              <div>
                <p className="section-kicker">外观</p>
                <h2>主题</h2>
              </div>
            </div>
            <div className="settings-theme-options">
              {([
                { key: 'system', label: '跟随系统' },
                { key: 'light', label: '明亮' },
                { key: 'dark', label: '暗色' },
              ] as const).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`theme-option ${props.theme === item.key ? 'is-active' : ''}`}
                  onClick={() => props.onChangeTheme(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="panel page-panel settings-card">
            <div className="panel-header">
              <div>
                <p className="section-kicker">服务</p>
                <h2>本地服务</h2>
              </div>
              <RefreshBadge active={props.isSettingsRefreshing} />
            </div>
            <dl className="settings-list">
              {props.loading ? <SettingsListSkeleton rows={6} /> : (
                <>
                  <div>
                    <dt>当前版本</dt>
                    <dd>v{props.agentSettings?.app_version ?? '--'}</dd>
                  </div>
                  <div>
                    <dt>接口地址</dt>
                    <dd>{API_BASE_URL}</dd>
                  </div>
                  <div>
                    <dt>前端地址</dt>
                    <dd>{props.agentSettings?.web_ui_url ?? '--'}</dd>
                  </div>
                  <div>
                    <dt>连接状态</dt>
                    <dd>{props.error ? '离线' : '在线'}</dd>
                  </div>
                  <div>
                    <dt>最后更新</dt>
                    <dd>{props.lastUpdatedAt ?? '等待连接'}</dd>
                  </div>
                  <div>
                    <dt>启动命令</dt>
                    <dd>{props.agentSettings?.launch_command ?? '--'}</dd>
                  </div>
                </>
              )}
            </dl>
          </div>

          <div className="panel page-panel settings-card">
            <div className="panel-header">
              <div>
                <p className="section-kicker">升级</p>
                <h2>在线升级</h2>
              </div>
            </div>

            <div className="settings-update-card">
              <div className="settings-update-summary">
                <div>
                  <span>当前版本</span>
                  <strong>v{props.agentSettings?.app_version ?? '--'}</strong>
                </div>
                <div>
                  <span>Latest</span>
                  <strong>
                    {props.updateInfo ? `v${props.updateInfo.latest_version}` : '等待检查'}
                  </strong>
                </div>
                <div>
                  <span>安装包</span>
                  <strong>{props.updateInfo?.asset_name ?? 'timeline-portable-*.zip'}</strong>
                </div>
              </div>

              <p className="settings-update-copy">
                从 GitHub Release latest 拉取最新便携包，只覆盖程序文件，保留本地
                <code>config/timeline.toml</code> 和 <code>data/</code>。
              </p>

              {props.updateInfo?.published_at ? (
                <p className="settings-update-meta">
                  发布时间 {new Date(props.updateInfo.published_at).toLocaleString()}
                </p>
              ) : null}

              {props.updateInfo?.release_url ? (
                <a
                  className="settings-update-link"
                  href={props.updateInfo.release_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  查看 Release
                </a>
              ) : null}

              <div className="settings-update-actions">
                <button
                  type="button"
                  className="settings-save-button"
                  disabled={props.loading || props.checkingUpdate || props.installingUpdate}
                  onClick={() => {
                    void props.onCheckUpdate()
                  }}
                >
                  {props.checkingUpdate ? '检查中…' : '检查更新'}
                </button>

                <button
                  type="button"
                  className="settings-save-button settings-save-button-secondary"
                  disabled={
                    props.loading ||
                    props.checkingUpdate ||
                    props.installingUpdate ||
                    !props.updateInfo?.has_update
                  }
                  onClick={() => {
                    void props.onInstallUpdate()
                  }}
                >
                  {props.installingUpdate ? '升级中…' : '升级并重启'}
                </button>
              </div>

              {!props.loading && props.updateError ? (
                <div className="settings-error">{props.updateError}</div>
              ) : null}
              {!props.loading && props.updateNotice ? (
                <div className="settings-notice">{props.updateNotice}</div>
              ) : null}
            </div>
          </div>

          <div className="panel page-panel settings-card">
            <p className="section-kicker">启动</p>
            <h2>启动与采集配置</h2>
            <dl className="settings-list">
              {props.loading ? <SettingsListSkeleton rows={4} /> : (
                <>
                  <div>
                    <dt>开机自启动</dt>
                    <dd>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={props.agentSettings?.autostart_enabled ?? false}
                        aria-label="开机自启动"
                        className={`toggle-switch ${props.agentSettings?.autostart_enabled ? 'is-active' : ''}`}
                        disabled={props.savingAutostart}
                        onClick={() => {
                          void props.onToggleAutostart(!(props.agentSettings?.autostart_enabled ?? false))
                        }}
                      >
                        <span className="toggle-switch-track" aria-hidden="true">
                          <span className="toggle-switch-thumb" />
                        </span>
                        <span className="toggle-switch-text">
                          {props.savingAutostart
                            ? '保存中…'
                            : props.agentSettings?.autostart_enabled
                              ? '已启用'
                              : '已禁用'}
                        </span>
                      </button>
                    </dd>
                  </div>
                  <div>
                    <dt>托盘菜单</dt>
                    <dd>{props.agentSettings?.tray_enabled ? '已启用' : '已禁用'}</dd>
                  </div>
                  <div>
                    <dt>日期</dt>
                    <dd>{props.selectedDate}</dd>
                  </div>
                  <div>
                    <dt>时区</dt>
                    <dd>{props.timezone}</dd>
                  </div>
                </>
              )}
            </dl>

            {props.loading ? (
              <SettingsConfigSkeleton />
            ) : (
              <div className="settings-config-grid" role="group" aria-label="采集、提醒与过滤设置">
                <label className="settings-config-field">
                  <span>空闲阈值（秒）</span>
                  <input
                    type="number"
                    min={15}
                    max={1800}
                    step={5}
                    value={idleThresholdSecs}
                    onChange={(event) => setIdleThresholdSecs(Number(event.target.value) || 0)}
                  />
                  <small className="settings-config-help">
                    超过该时长无键盘/鼠标输入将判定为 Idle，建议 60~120 秒。
                  </small>
                </label>

                <label className="settings-config-field">
                  <span>轮询间隔（毫秒）</span>
                  <input
                    type="number"
                    min={250}
                    max={5000}
                    step={50}
                    value={pollIntervalMillis}
                    onChange={(event) => setPollIntervalMillis(Number(event.target.value) || 0)}
                  />
                  <small className="settings-config-help">
                    越小越实时但资源占用更高；建议保持 500~1500 毫秒。
                  </small>
                </label>

                <label className="settings-config-check">
                  <input
                    type="checkbox"
                    checked={healthReminderEnabled}
                    onChange={(event) => setHealthReminderEnabled(event.target.checked)}
                  />
                  <span>
                    健康休息提醒
                    <small>连续活跃超过阈值后发送系统提醒，建议保持开启。</small>
                  </span>
                </label>

                <label className="settings-config-field">
                  <span>休息提醒阈值（秒）</span>
                  <input
                    type="number"
                    min={300}
                    max={21600}
                    step={60}
                    value={healthReminderThresholdSecs}
                    disabled={!healthReminderEnabled}
                    onChange={(event) =>
                      setHealthReminderThresholdSecs(Number(event.target.value) || 0)}
                  />
                  <small className="settings-config-help">
                    默认 3000 秒（50 分钟），进入 Idle/Locked 后会重新计时。
                  </small>
                </label>

                <label className="settings-config-check">
                  <input
                    type="checkbox"
                    checked={recordWindowTitles}
                    onChange={(event) => setRecordWindowTitles(event.target.checked)}
                  />
                  <span>
                    记录窗口标题
                    <small>用于更细粒度窗口识别，关闭可减少隐私暴露。</small>
                  </span>
                </label>

                <label className="settings-config-check">
                  <input
                    type="checkbox"
                    checked={recordPageTitles}
                    onChange={(event) => setRecordPageTitles(event.target.checked)}
                  />
                  <span>
                    记录页面标题
                    <small>浏览器页面将保留标题，关闭后仅记录域名。</small>
                  </span>
                </label>

                <label className="settings-config-field is-wide">
                  <span>忽略应用（每行一个，如 chrome.exe）</span>
                  <textarea
                    rows={4}
                    value={ignoredAppsText}
                    onChange={(event) => setIgnoredAppsText(event.target.value)}
                  />
                  <small className="settings-config-help">
                    命中列表的应用将不写入焦点记录，支持换行或逗号分隔。
                  </small>
                </label>

                <label className="settings-config-field is-wide">
                  <span>忽略域名（每行一个，如 example.com）</span>
                  <textarea
                    rows={4}
                    value={ignoredDomainsText}
                    onChange={(event) => setIgnoredDomainsText(event.target.value)}
                  />
                  <small className="settings-config-help">
                    命中列表的域名不会进入浏览器记录，适合排除隐私或噪声站点。
                  </small>
                </label>

                <div className="settings-config-actions">
                  <button
                    type="button"
                    className="settings-save-button"
                    disabled={props.savingConfig}
                    onClick={() => {
                      void handleSaveConfig()
                    }}
                  >
                    {props.savingConfig ? '保存中…' : '保存采集配置'}
                  </button>
                </div>
              </div>
            )}

            {!props.loading && props.settingsError ? <div className="settings-error">{props.settingsError}</div> : null}
            {!props.loading && props.settingsNotice ? <div className="settings-notice">{props.settingsNotice}</div> : null}
          </div>
        </div>

        <div className="page-content-side">
          <div className="panel page-panel settings-card settings-monitor-card">
            <p className="section-kicker">监视器</p>
            <h2>监视器状态</h2>
            <div className="monitor-list">
              {props.loading ? (
                <MonitorListSkeleton />
              ) : (
                props.agentSettings?.monitors.map((monitor) => (
                  <article key={monitor.key} className="monitor-card">
                    <div className="monitor-head">
                      <strong>{monitor.label}</strong>
                      <span className={`monitor-badge is-${monitor.status}`}>{monitor.status}</span>
                    </div>
                    <p>{monitor.detail}</p>
                    <small>
                      {monitor.last_seen ? `最后活跃 ${new Date(monitor.last_seen).toLocaleTimeString()}` : '等待首次心跳'}
                    </small>
                  </article>
                )) ?? <div className="empty-card">读取中…</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function RefreshBadge(props: { active: boolean }) {
  void props
  return null
}

function SettingsListSkeleton(props: { rows: number }) {
  return (
    <>
      {Array.from({ length: props.rows }, (_, index) => (
        <div key={`settings-skeleton-${index}`} className="settings-skeleton-row">
          <dt>
            <span className="skeleton-block skeleton-inline skeleton-settings-label" />
          </dt>
          <dd>
            <span className="skeleton-block skeleton-inline skeleton-settings-value" />
          </dd>
        </div>
      ))}
    </>
  )
}

function SettingsConfigSkeleton() {
  return (
    <div className="settings-config-grid settings-config-grid-skeleton" aria-hidden="true">
      {Array.from({ length: 2 }, (_, index) => (
        <div key={`settings-field-${index}`} className="settings-config-field settings-config-field-skeleton">
          <span className="skeleton-block skeleton-inline skeleton-field-label" />
          <span className="skeleton-block skeleton-input" />
          <span className="skeleton-block skeleton-inline skeleton-field-help" />
        </div>
      ))}
      {Array.from({ length: 2 }, (_, index) => (
        <div key={`settings-check-${index}`} className="settings-config-check settings-config-check-skeleton">
          <span className="skeleton-block skeleton-checkbox" />
          <span className="settings-config-check-copy">
            <span className="skeleton-block skeleton-inline skeleton-check-title" />
            <span className="skeleton-block skeleton-inline skeleton-check-help" />
          </span>
        </div>
      ))}
      {Array.from({ length: 2 }, (_, index) => (
        <div
          key={`settings-textarea-${index}`}
          className="settings-config-field settings-config-field-skeleton is-wide"
        >
          <span className="skeleton-block skeleton-inline skeleton-field-label" />
          <span className="skeleton-block skeleton-textarea" />
          <span className="skeleton-block skeleton-inline skeleton-field-help" />
        </div>
      ))}
      <div className="settings-config-actions settings-config-actions-skeleton">
        <span className="skeleton-block skeleton-button" />
      </div>
    </div>
  )
}

function MonitorListSkeleton() {
  return (
    <>
      {Array.from({ length: 3 }, (_, index) => (
        <article key={`monitor-skeleton-${index}`} className="monitor-card monitor-card-skeleton">
          <div className="monitor-head">
            <span className="skeleton-block skeleton-inline skeleton-monitor-title" />
            <span className="skeleton-block skeleton-inline skeleton-monitor-badge" />
          </div>
          <span className="skeleton-block skeleton-inline skeleton-monitor-line" />
          <span className="skeleton-block skeleton-inline skeleton-monitor-line skeleton-monitor-line-short" />
        </article>
      ))}
    </>
  )
}
