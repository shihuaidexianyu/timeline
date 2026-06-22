import { useState } from 'react'
import {
  API_BASE_URL,
  useAgentSettingsQuery,
  useUpdateAgentConfigMutation,
  useUpdateAutostartMutation,
  type AgentMonitorStatus,
  type AgentSettingsResponse,
  type UpdateAgentConfigRequest,
} from '../api'
import {
  formValuesToUpdatePayload,
  settingsFormKey,
  settingsToFormValues,
  type SettingsFormValues,
} from '../features/settings/settings-form'
import type { ThemeMode } from '../hooks/use-theme'
import { RefreshBadge } from '../shared/ui'
import type { SharedData } from '../app/use-shared-data'

export function SettingsPage(props: {
  shared: SharedData
  theme: ThemeMode
  onChangeTheme: (theme: ThemeMode) => void
}) {
  const settingsQuery = useAgentSettingsQuery()
  const updateConfigMutation = useUpdateAgentConfigMutation()
  const updateAutostartMutation = useUpdateAutostartMutation()
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null)

  const agentSettings = settingsQuery.data ?? null
  const loading = !settingsQuery.data && settingsQuery.isPending
  const error = settingsQuery.error instanceof Error
    ? settingsQuery.error.message
    : settingsQuery.error
      ? '设置加载失败'
      : null
  const savingAutostart = updateAutostartMutation.isPending
  const savingConfig = updateConfigMutation.isPending
  const isSettingsRefreshing = settingsQuery.isFetching && Boolean(settingsQuery.data)
  const selectedDate = props.shared.resolvedSelectedDate
  const timezone = props.shared.resolvedTimezone
  const lastUpdatedAt = props.shared.lastTimelineDataUpdatedAt > 0
    ? new Date(props.shared.lastTimelineDataUpdatedAt).toLocaleTimeString()
    : null

  const onToggleAutostart = async (enabled: boolean) => {
    setSettingsError(null)
    setSettingsNotice(null)
    try {
      await updateAutostartMutation.mutateAsync({ enabled })
    } catch (toggleError) {
      setSettingsError(
        toggleError instanceof Error ? toggleError.message : '更新开机自启动设置失败',
      )
    }
  }

  const onUpdateConfig = async (payload: UpdateAgentConfigRequest) => {
    setSettingsError(null)
    setSettingsNotice(null)
    try {
      const result = await updateConfigMutation.mutateAsync(payload)
      if (result.saved) {
        setSettingsNotice(
          result.requires_restart
            ? '设置已保存，重启 timeline 后生效。'
            : null,
        )
      }
    } catch (updateError) {
      setSettingsError(
        updateError instanceof Error ? updateError.message : '更新本地配置失败',
      )
    }
  }
  return (
    <section className="page-stack settings-page">
      <h1 className="page-title">设置</h1>

      <div className="settings-winui-layout">
        <div className="settings-winui-main">
          {/* Appearance */}
          <section className="settings-winui-section">
            <h3 className="settings-winui-section-title">外观</h3>
            <div className="settings-winui-card">
              <div className="settings-winui-row">
                <div className="settings-winui-row-label">主题</div>
                <div className="settings-winui-row-desc">选择应用的显示模式</div>
                <div className="settings-winui-row-control">
                  <div className="settings-theme-options" role="radiogroup" aria-label="主题">
                    {([
                      { key: 'system', label: '跟随系统' },
                      { key: 'light', label: '明亮' },
                      { key: 'dark', label: '暗色' },
                    ] as const).map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        role="radio"
                        aria-checked={props.theme === item.key}
                        className={`theme-option ${props.theme === item.key ? 'is-active' : ''}`}
                        onClick={() => props.onChangeTheme(item.key)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Service info */}
          <section className="settings-winui-section">
            <h3 className="settings-winui-section-title">本地服务</h3>
            <div className="settings-winui-card">
              <div className="settings-winui-card-header">
                <div>
                  <div className="settings-winui-card-title">连接信息</div>
                  <div className="settings-winui-card-subtitle">当前与本地 timeline 服务的连接状态</div>
                </div>
                <RefreshBadge active={isSettingsRefreshing} />
              </div>
              {loading ? <SettingsListSkeleton rows={5} /> : (
                <dl className="settings-winui-list">
                  <div>
                    <dt>接口地址</dt>
                    <dd className="settings-winui-mono">{API_BASE_URL}</dd>
                  </div>
                  <div>
                    <dt>前端地址</dt>
                    <dd className="settings-winui-mono">{agentSettings?.web_ui_url ?? '--'}</dd>
                  </div>
                  <div>
                    <dt>连接状态</dt>
                    <dd>
                      <span className={`settings-status-dot ${error ? 'is-offline' : 'is-online'}`} />
                      {error ? '离线' : '在线'}
                    </dd>
                  </div>
                  <div>
                    <dt>最后更新</dt>
                    <dd className="settings-winui-mono">{lastUpdatedAt ?? '等待连接'}</dd>
                  </div>
                  <div>
                    <dt>启动命令</dt>
                    <dd className="settings-winui-mono">{agentSettings?.launch_command ?? '--'}</dd>
                  </div>
                </dl>
              )}
            </div>
          </section>

          {/* Data management: export + backup hint */}
          <section className="settings-winui-section">
            <h3 className="settings-winui-section-title">数据管理</h3>
            <div className="settings-winui-card">
              <div className="settings-winui-card-header">
                <div>
                  <div className="settings-winui-card-title">导出当日数据</div>
                  <div className="settings-winui-card-subtitle">
                    导出 {selectedDate} 的完整 segment 数据为 CSV 或 JSON 文件
                  </div>
                </div>
              </div>
              <div className="settings-winui-row">
                <div className="settings-winui-row-label">导出格式</div>
                <div className="settings-winui-row-control">
                  <div className="ui-segmented" role="group" aria-label="导出格式">
                    <a
                      className="ui-segmented-item"
                      href={`${API_BASE_URL}/api/export?date=${selectedDate}&format=csv`}
                      download={`timeline-${selectedDate}.csv`}
                    >
                      CSV
                    </a>
                    <a
                      className="ui-segmented-item"
                      href={`${API_BASE_URL}/api/export?date=${selectedDate}&format=json`}
                      download={`timeline-${selectedDate}.json`}
                    >
                      JSON
                    </a>
                  </div>
                </div>
              </div>
            </div>

            <div className="settings-winui-card">
              <div className="settings-winui-card-header">
                <div>
                  <div className="settings-winui-card-title">数据备份</div>
                  <div className="settings-winui-card-subtitle">
                    所有数据保存在本地 SQLite 数据库中。建议定期备份以下路径的文件
                  </div>
                </div>
              </div>
              <dl className="settings-winui-list">
                <div>
                  <dt>备份建议</dt>
                  <dd>
                    关闭 timeline 后复制数据库文件到安全位置即可完成备份。
                    数据库使用 WAL 模式，建议同时复制 <code>-wal</code> 和 <code>-shm</code> 文件。
                  </dd>
                </div>
              </dl>
            </div>
          </section>

          {/* Startup & collection */}
          <section className="settings-winui-section">
            <h3 className="settings-winui-section-title">启动与采集</h3>
            <div className="settings-winui-card">
              {loading || !agentSettings ? (
                <SettingsConfigSkeleton />
              ) : (
                <>
                  <div className="settings-winui-row is-action">
                    <div>
                      <div className="settings-winui-row-label">开机自启动</div>
                      <div className="settings-winui-row-desc">登录 Windows 时自动启动 timeline</div>
                    </div>
                    <div className="settings-winui-row-control">
                      <ToggleSwitch
                        checked={agentSettings.autostart_enabled}
                        saving={savingAutostart}
                        onToggle={() => {
                          void onToggleAutostart(!agentSettings!.autostart_enabled)
                        }}
                      />
                    </div>
                  </div>
                  <div className="settings-winui-divider" />
                  <div className="settings-winui-row">
                    <div className="settings-winui-row-label">托盘菜单</div>
                    <div className="settings-winui-row-desc">在系统托盘显示图标和菜单</div>
                    <div className="settings-winui-row-control">
                      <span className="settings-winui-value">
                        {agentSettings.tray_enabled ? '已启用' : '已禁用'}
                      </span>
                    </div>
                  </div>
                  <div className="settings-winui-divider" />
                  <div className="settings-winui-row">
                    <div className="settings-winui-row-label">当前日期</div>
                    <div className="settings-winui-row-desc">统计和趋势页面当前选中的日期</div>
                    <div className="settings-winui-row-control">
                      <span className="settings-winui-value">{selectedDate}</span>
                    </div>
                  </div>
                  <div className="settings-winui-divider" />
                  <div className="settings-winui-row">
                    <div className="settings-winui-row-label">系统时区</div>
                    <div className="settings-winui-row-desc">本地时间显示使用的时区</div>
                    <div className="settings-winui-row-control">
                      <span className="settings-winui-value">{timezone}</span>
                    </div>
                  </div>

                  <div className="settings-winui-divider is-section" />

                  <SettingsConfigForm
                    key={settingsFormKey(agentSettings)}
                    settings={agentSettings}
                    savingConfig={savingConfig}
                    onUpdateConfig={onUpdateConfig}
                  />
                </>
              )}

                    {!loading && settingsError ? <div className="settings-error">{settingsError}</div> : null}
                    {!loading && settingsNotice ? <div className="settings-notice">{settingsNotice}</div> : null}
            </div>
          </section>
        </div>

        {/* Monitors */}
        <div className="settings-winui-side">
          <section className="settings-winui-section">
            <h3 className="settings-winui-section-title">监视器</h3>
            <div className="settings-winui-card">
              {loading ? (
                <MonitorListSkeleton />
              ) : (
                <MonitorStatusPanel monitors={agentSettings?.monitors ?? []} />
              )}
            </div>
          </section>
        </div>
      </div>
    </section>
  )
}

function MonitorStatusPanel(props: { monitors: AgentMonitorStatus[] }) {
  const summary = getMonitorSummary(props.monitors)

  return (
    <>
      <div className={`monitor-summary is-${summary.tone}`}>
        <span className="monitor-summary-indicator" aria-hidden="true" />
        <div>
          <div className="monitor-summary-title">{summary.title}</div>
          <div className="monitor-summary-subtitle">{summary.subtitle}</div>
        </div>
      </div>

      <div className="monitor-list" role="list" aria-label="采集模块状态">
        {props.monitors.length > 0 ? (
          props.monitors.map((monitor) => (
            <article
              key={monitor.key}
              className={`monitor-row is-${monitorStatusTone(monitor.status)}`}
              role="listitem"
            >
              <span className="monitor-row-dot" aria-hidden="true" />
              <div className="monitor-row-main">
                <strong>{monitor.label}</strong>
                <p>{monitor.detail}</p>
              </div>
              <div className="monitor-row-meta">
                <span className={`monitor-badge is-${monitorStatusTone(monitor.status)}`}>
                  {monitorStatusLabel(monitor.status)}
                </span>
                <span className="monitor-last-seen">{formatMonitorLastSeen(monitor.last_seen)}</span>
              </div>
            </article>
          ))
        ) : (
          <div className="monitor-empty">等待采集模块上报心跳</div>
        )}
      </div>
    </>
  )
}

type MonitorTone = 'online' | 'stale' | 'waiting'

function monitorStatusTone(status: string): MonitorTone {
  if (status === 'online') {
    return 'online'
  }

  if (status === 'stale') {
    return 'stale'
  }

  return 'waiting'
}

function monitorStatusLabel(status: string) {
  if (status === 'online') {
    return '正常'
  }

  if (status === 'stale') {
    return '延迟'
  }

  if (status === 'disabled') {
    return '关闭'
  }

  if (status === 'waiting') {
    return '等待'
  }

  return status
}

function formatMonitorLastSeen(lastSeen: string | null) {
  if (!lastSeen) {
    return '未收到'
  }

  const date = new Date(lastSeen)
  if (Number.isNaN(date.getTime())) {
    return '时间未知'
  }

  return date.toLocaleTimeString()
}

function getMonitorSummary(monitors: AgentMonitorStatus[]): {
  title: string
  subtitle: string
  tone: MonitorTone
} {
  if (monitors.length === 0) {
    return {
      title: '等待采集模块心跳',
      subtitle: '启动后会在这里显示各模块状态',
      tone: 'waiting',
    }
  }

  const onlineCount = monitors.filter((monitor) => monitor.status === 'online').length
  const staleCount = monitors.filter((monitor) => monitor.status === 'stale').length
  const inactiveCount = monitors.length - onlineCount - staleCount

  if (staleCount > 0) {
    return {
      title: `${staleCount} 个模块需要注意`,
      subtitle: `${onlineCount} 个正常，检查最近心跳时间`,
      tone: 'stale',
    }
  }

  if (inactiveCount > 0) {
    return {
      title: `${onlineCount} 个正常，${inactiveCount} 个未运行`,
      subtitle: '等待或关闭的模块不会影响已启用采集',
      tone: 'waiting',
    }
  }

  return {
    title: `${monitors.length} 个采集模块正常`,
    subtitle: '采集服务正在稳定运行',
    tone: 'online',
  }
}

function ToggleSwitch(props: {
  checked: boolean
  saving: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label="开机自启动"
      className={`toggle-switch ${props.checked ? 'is-active' : ''}`}
      disabled={props.saving}
      onClick={props.onToggle}
    >
      <span className="toggle-switch-track" aria-hidden="true">
        <span className="toggle-switch-thumb" />
      </span>
      <span className="toggle-switch-text">
        {props.saving ? '保存中…' : props.checked ? '开' : '关'}
      </span>
    </button>
  )
}

function SettingsConfigForm(props: {
  settings: AgentSettingsResponse
  savingConfig: boolean
  onUpdateConfig: (payload: UpdateAgentConfigRequest) => Promise<void>
}) {
  const [values, setValues] = useState<SettingsFormValues>(() =>
    settingsToFormValues(props.settings),
  )

  function patchValues(patch: Partial<SettingsFormValues>) {
    setValues((current) => ({ ...current, ...patch }))
  }

  async function handleSaveConfig() {
    await props.onUpdateConfig(formValuesToUpdatePayload(values))
  }

  return (
    <div className="settings-form" role="group" aria-label="采集、提醒与过滤设置">
      <div className="settings-form-section">
        <h4 className="settings-form-section-title">采集频率</h4>
        <div className="settings-winui-row">
          <div>
            <div className="settings-winui-row-label">空闲阈值</div>
            <div className="settings-winui-row-desc">超过该时长无输入将判定为 Idle</div>
          </div>
          <div className="settings-winui-row-control">
            <div className="settings-input-with-suffix">
              <input
                type="number"
                min={15}
                max={1800}
                step={5}
                value={values.idleThresholdSecs}
                onChange={(event) =>
                  patchValues({ idleThresholdSecs: Number(event.target.value) || 0 })}
              />
              <span className="settings-input-suffix">秒</span>
            </div>
          </div>
        </div>
        <div className="settings-winui-divider" />
        <div className="settings-winui-row">
          <div>
            <div className="settings-winui-row-label">轮询间隔</div>
            <div className="settings-winui-row-desc">检测前台窗口的时间间隔</div>
          </div>
          <div className="settings-winui-row-control">
            <div className="settings-input-with-suffix">
              <input
                type="number"
                min={250}
                max={5000}
                step={50}
                value={values.pollIntervalMillis}
                onChange={(event) =>
                  patchValues({ pollIntervalMillis: Number(event.target.value) || 0 })}
              />
              <span className="settings-input-suffix">毫秒</span>
            </div>
          </div>
        </div>
      </div>

      <div className="settings-form-section">
        <h4 className="settings-form-section-title">健康提醒</h4>
        <div className="settings-winui-row is-action">
          <div>
            <div className="settings-winui-row-label">健康休息提醒</div>
            <div className="settings-winui-row-desc">连续活跃超过阈值后发送系统提醒</div>
          </div>
          <div className="settings-winui-row-control">
            <label className="settings-config-check">
              <input
                type="checkbox"
                checked={values.healthReminderEnabled}
                onChange={(event) =>
                  patchValues({ healthReminderEnabled: event.target.checked })}
              />
              <span className="toggle-switch-text">
                {values.healthReminderEnabled ? '开' : '关'}
              </span>
            </label>
          </div>
        </div>
        <div className="settings-winui-divider" />
        <div className="settings-winui-row">
          <div>
            <div className="settings-winui-row-label">提醒阈值</div>
            <div className="settings-winui-row-desc">进入 Idle/Locked 后会重新计时</div>
          </div>
          <div className="settings-winui-row-control">
            <div className="settings-input-with-suffix">
              <input
                type="number"
                min={300}
                max={21600}
                step={60}
                value={values.healthReminderThresholdSecs}
                disabled={!values.healthReminderEnabled}
                onChange={(event) =>
                  patchValues({ healthReminderThresholdSecs: Number(event.target.value) || 0 })}
              />
              <span className="settings-input-suffix">秒</span>
            </div>
          </div>
        </div>
      </div>

      <div className="settings-form-section">
        <h4 className="settings-form-section-title">隐私记录</h4>
        <div className="settings-winui-row is-action">
          <div>
            <div className="settings-winui-row-label">记录窗口标题</div>
            <div className="settings-winui-row-desc">关闭可减少隐私暴露</div>
          </div>
          <div className="settings-winui-row-control">
            <label className="settings-config-check">
              <input
                type="checkbox"
                checked={values.recordWindowTitles}
                onChange={(event) => patchValues({ recordWindowTitles: event.target.checked })}
              />
              <span className="toggle-switch-text">
                {values.recordWindowTitles ? '开' : '关'}
              </span>
            </label>
          </div>
        </div>
        <div className="settings-winui-divider" />
        <div className="settings-winui-row is-action">
          <div>
            <div className="settings-winui-row-label">记录页面标题</div>
            <div className="settings-winui-row-desc">关闭后浏览器仅记录域名</div>
          </div>
          <div className="settings-winui-row-control">
            <label className="settings-config-check">
              <input
                type="checkbox"
                checked={values.recordPageTitles}
                onChange={(event) => patchValues({ recordPageTitles: event.target.checked })}
              />
              <span className="toggle-switch-text">
                {values.recordPageTitles ? '开' : '关'}
              </span>
            </label>
          </div>
        </div>
      </div>

      <div className="settings-form-section">
        <h4 className="settings-form-section-title">过滤列表</h4>
        <label className="settings-config-field is-wide">
          <span>忽略应用（每行一个，如 chrome.exe）</span>
          <textarea
            rows={4}
            value={values.ignoredAppsText}
            onChange={(event) => patchValues({ ignoredAppsText: event.target.value })}
          />
        </label>
        <label className="settings-config-field is-wide">
          <span>忽略域名（每行一个，如 example.com）</span>
          <textarea
            rows={4}
            value={values.ignoredDomainsText}
            onChange={(event) => patchValues({ ignoredDomainsText: event.target.value })}
          />
        </label>
        <label className="settings-config-field is-wide">
          <span>域名归组（每行一个，格式：组名 = [域名1, 域名2, *.后缀]）</span>
          <textarea
            rows={3}
            value={values.domainGroupsText}
            onChange={(event) => patchValues({ domainGroupsText: event.target.value })}
            placeholder="github = [github.com, gist.github.com, *.github.io]"
          />
        </label>
      </div>

      <div className="settings-form-actions">
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
  )
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
    <div className="settings-form settings-form-skeleton" aria-hidden="true">
      {Array.from({ length: 2 }, (_, index) => (
        <div key={`settings-section-${index}`} className="settings-form-section">
          <span className="skeleton-block skeleton-inline skeleton-section-title" />
          <div className="settings-winui-row">
            <div>
              <span className="skeleton-block skeleton-inline skeleton-field-label" />
              <span className="skeleton-block skeleton-inline skeleton-field-help" />
            </div>
            <span className="skeleton-block skeleton-input" />
          </div>
          <div className="settings-winui-divider" />
          <div className="settings-winui-row">
            <div>
              <span className="skeleton-block skeleton-inline skeleton-field-label" />
              <span className="skeleton-block skeleton-inline skeleton-field-help" />
            </div>
            <span className="skeleton-block skeleton-input" />
          </div>
        </div>
      ))}
      <div className="settings-form-actions settings-form-actions-skeleton">
        <span className="skeleton-block skeleton-button" />
      </div>
    </div>
  )
}

function MonitorListSkeleton() {
  return (
    <>
      <div className="monitor-summary monitor-summary-skeleton" aria-hidden="true">
        <span className="skeleton-block skeleton-inline skeleton-monitor-dot" />
        <div>
          <span className="skeleton-block skeleton-inline skeleton-monitor-title" />
          <span className="skeleton-block skeleton-inline skeleton-monitor-line skeleton-monitor-line-short" />
        </div>
      </div>
      {Array.from({ length: 3 }, (_, index) => (
        <article key={`monitor-skeleton-${index}`} className="monitor-row monitor-row-skeleton">
          <span className="skeleton-block skeleton-inline skeleton-monitor-dot" />
          <div className="monitor-row-main">
            <span className="skeleton-block skeleton-inline skeleton-monitor-title" />
            <span className="skeleton-block skeleton-inline skeleton-monitor-line" />
          </div>
          <div className="monitor-row-meta">
            <span className="skeleton-block skeleton-inline skeleton-monitor-badge" />
            <span className="skeleton-block skeleton-inline skeleton-monitor-time" />
          </div>
        </article>
      ))}
    </>
  )
}
