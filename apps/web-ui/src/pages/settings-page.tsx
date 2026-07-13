import { useState } from 'react'
import {
  API_BASE_URL,
  type AgentSettingsResponse,
  type DeleteDataRequest,
  type PauseTrackingRequest,
  type UpdateAgentConfigRequest,
} from '../api'
import {
  appendConfigListItem,
  configListIncludes,
  formValuesToUpdatePayload,
  settingsFormKey,
  settingsToFormValues,
  type SettingsFormValues,
} from '../features/settings/settings-form'
import type { ThemeMode } from '../hooks/use-theme'
import { RefreshBadge } from '../shared/ui'

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatLocalDateTime(value: string | null | undefined) {
  if (!value) return '尚未备份'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '未知' : date.toLocaleString('zh-CN')
}

function nextLocalMidnightIso() {
  const tomorrow = new Date()
  tomorrow.setHours(24, 0, 0, 0)
  return tomorrow.toISOString()
}

function monitorStatusLabel(status: string) {
  return ({
    online: '在线',
    degraded: '降级',
    recovering: '恢复中',
    offline: '离线',
    disabled: '已禁用',
    waiting: '等待中',
  } as Record<string, string>)[status] ?? status
}

export function SettingsPage(props: {
  agentSettings: AgentSettingsResponse | null
  loading: boolean
  error: string | null
  settingsError: string | null
  settingsNotice: string | null
  lastUpdatedAt: string | null
  selectedDate: string
  timezone: string
  savingAutostart: boolean
  savingConfig: boolean
  savingTracking: boolean
  deletingData: boolean
  isSettingsRefreshing: boolean
  theme: ThemeMode
  onChangeTheme: (theme: ThemeMode) => void
  onToggleAutostart: (enabled: boolean) => Promise<void>
  onUpdateConfig: (payload: UpdateAgentConfigRequest) => Promise<void>
  onPauseTracking: (payload: PauseTrackingRequest) => Promise<unknown>
  onResumeTracking: () => Promise<unknown>
  onUpdateRetention: (days: number | null) => Promise<void>
  onDeleteData: (payload: DeleteDataRequest) => Promise<void>
}) {
  const [dataFrom, setDataFrom] = useState(props.selectedDate)
  const [dataTo, setDataTo] = useState(props.selectedDate)
  const validDataRange = dataFrom.length > 0 && dataTo.length > 0 && dataFrom <= dataTo
  const exportQuery = new URLSearchParams({ from: dataFrom, to: dataTo }).toString()

  function confirmDelete(message: string, finalMessage: string) {
    return window.confirm(message) && window.confirm(finalMessage)
  }

  return (
    <section className="page-stack settings-page">
      <div className="settings-winui-layout">
        <div className="settings-winui-main">
          {/* Appearance */}
          <section className="settings-winui-section">
            <h2 className="settings-winui-section-title">外观</h2>
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
            <h2 className="settings-winui-section-title">本地服务</h2>
            <div className="settings-winui-card">
              <div className="settings-winui-card-header">
                <div>
                  <div className="settings-winui-card-title">连接信息</div>
                  <div className="settings-winui-card-subtitle">当前与本地 timeline 服务的连接状态</div>
                </div>
                <RefreshBadge active={props.isSettingsRefreshing} />
              </div>
              {props.loading ? <SettingsListSkeleton rows={5} /> : (
                <dl className="settings-winui-list">
                  <div>
                    <dt>接口地址</dt>
                    <dd className="settings-winui-mono">{API_BASE_URL}</dd>
                  </div>
                  <div>
                    <dt>前端地址</dt>
                    <dd className="settings-winui-mono">{props.agentSettings?.web_ui_url ?? '--'}</dd>
                  </div>
                  <div>
                    <dt>连接状态</dt>
                    <dd>
                      <span className={`settings-status-dot ${props.error ? 'is-offline' : 'is-online'}`} />
                      {props.error ? '离线' : '在线'}
                    </dd>
                  </div>
                  <div>
                    <dt>最后更新</dt>
                    <dd className="settings-winui-mono">{props.lastUpdatedAt ?? '等待连接'}</dd>
                  </div>
                  <div>
                    <dt>启动命令</dt>
                    <dd className="settings-winui-mono">{props.agentSettings?.launch_command ?? '--'}</dd>
                  </div>
                </dl>
              )}
            </div>
          </section>

          {/* Startup & collection */}
          <section className="settings-winui-section">
            <h2 className="settings-winui-section-title">启动与采集</h2>
            <div className="settings-winui-card">
              {props.loading || !props.agentSettings ? (
                <SettingsConfigSkeleton />
              ) : (
                <>
                  <div className="settings-winui-row is-action">
                    <div>
                      <div className="settings-winui-row-label">采集状态</div>
                      <div className="settings-winui-row-desc">
                        {props.agentSettings.tracking_paused
                          ? `已暂停${props.agentSettings.pause_until ? `，将于 ${new Date(props.agentSettings.pause_until).toLocaleString()} 自动恢复` : ''}`
                          : '正在记录前台应用和使用状态'}
                      </div>
                    </div>
                    <div className="settings-winui-row-control settings-inline-actions">
                      {props.agentSettings.tracking_paused ? (
                        <button
                          type="button"
                          className="settings-save-button"
                          disabled={props.savingTracking}
                          onClick={() => void props.onResumeTracking()}
                        >恢复采集</button>
                      ) : (
                        <>
                          <button type="button" disabled={props.savingTracking} onClick={() => void props.onPauseTracking({ duration_secs: 900 })}>暂停 15 分钟</button>
                          <button type="button" disabled={props.savingTracking} onClick={() => void props.onPauseTracking({ duration_secs: 3600 })}>暂停 1 小时</button>
                          <button type="button" disabled={props.savingTracking} onClick={() => void props.onPauseTracking({ until: nextLocalMidnightIso() })}>暂停到明天</button>
                          <button type="button" disabled={props.savingTracking} onClick={() => void props.onPauseTracking({})}>暂停到手动恢复</button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="settings-winui-divider" />
                  <div className="settings-winui-row is-action">
                    <div>
                      <div className="settings-winui-row-label">开机自启动</div>
                      <div className="settings-winui-row-desc">登录 Windows 时自动启动 timeline</div>
                    </div>
                    <div className="settings-winui-row-control">
                      <ToggleSwitch
                        checked={props.agentSettings.autostart_enabled}
                        saving={props.savingAutostart}
                        onToggle={() => {
                          void props.onToggleAutostart(!props.agentSettings!.autostart_enabled)
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
                        {props.agentSettings.tray_enabled ? '已启用' : '已禁用'}
                      </span>
                    </div>
                  </div>
                  <div className="settings-winui-divider" />
                  <div className="settings-winui-row">
                    <div className="settings-winui-row-label">当前日期</div>
                    <div className="settings-winui-row-desc">时间线页面默认选中的日期</div>
                    <div className="settings-winui-row-control">
                      <span className="settings-winui-value">{props.selectedDate}</span>
                    </div>
                  </div>
                  <div className="settings-winui-divider" />
                  <div className="settings-winui-row">
                    <div className="settings-winui-row-label">系统时区</div>
                    <div className="settings-winui-row-desc">本地时间显示使用的时区</div>
                    <div className="settings-winui-row-control">
                      <span className="settings-winui-value">{props.timezone}</span>
                    </div>
                  </div>

                  <div className="settings-winui-divider is-section" />

                  <SettingsConfigForm
                    key={settingsFormKey(props.agentSettings)}
                    settings={props.agentSettings}
                    savingConfig={props.savingConfig}
                    onUpdateConfig={props.onUpdateConfig}
                  />
                </>
              )}

              {!props.loading && props.settingsError ? <div className="settings-error">{props.settingsError}</div> : null}
              {!props.loading && props.settingsNotice ? <div className="settings-notice">{props.settingsNotice}</div> : null}
            </div>
          </section>

          <section className="settings-winui-section">
            <h2 className="settings-winui-section-title">数据管理</h2>
            <div className="settings-winui-card">
              <dl className="settings-winui-list">
                <div><dt>数据库大小</dt><dd>{formatBytes(props.agentSettings?.database_size_bytes ?? 0)}</dd></div>
                <div><dt>最早记录</dt><dd>{props.agentSettings?.earliest_recorded_date ?? '暂无数据'}</dd></div>
                <div><dt>最后备份</dt><dd>{formatLocalDateTime(props.agentSettings?.last_backup_at)}</dd></div>
                <div><dt>版本</dt><dd>{props.agentSettings ? `${props.agentSettings.version} · schema ${props.agentSettings.schema_version}` : '--'}</dd></div>
              </dl>
              <div className="settings-winui-row">
                <div><div className="settings-winui-row-label">数据保留</div><div className="settings-winui-row-desc">默认永久保留，可自动清理较早记录</div></div>
                <div className="settings-winui-row-control">
                  <select
                    value={props.agentSettings?.retention_days ?? ''}
                    onChange={(event) => void props.onUpdateRetention(event.target.value ? Number(event.target.value) : null)}
                  >
                    <option value="">永久</option><option value="90">90 天</option><option value="180">半年</option><option value="365">一年</option>
                  </select>
                </div>
              </div>
              <div className="settings-winui-divider" />
              <div className="settings-winui-row is-action settings-data-range">
                <div>
                  <div className="settings-winui-row-label">导出或删除范围</div>
                  <div className="settings-winui-row-desc">起止日期均包含在内；删除会同时重建受影响的统计</div>
                </div>
                <div className="settings-winui-row-control settings-date-range-inputs">
                  <label>开始日期<input type="date" value={dataFrom} max={dataTo || undefined} onChange={(event) => setDataFrom(event.target.value)} /></label>
                  <label>结束日期<input type="date" value={dataTo} min={dataFrom || undefined} onChange={(event) => setDataTo(event.target.value)} /></label>
                  <button type="button" onClick={() => { setDataFrom(props.selectedDate); setDataTo(props.selectedDate) }}>使用当前日期</button>
                </div>
              </div>
              <div className="settings-winui-divider" />
              <div className="settings-inline-actions settings-data-actions">
                <a aria-disabled={!validDataRange} href={validDataRange ? `${API_BASE_URL}/api/data/export?format=json&${exportQuery}` : undefined}>导出范围 JSON</a>
                <a aria-disabled={!validDataRange} href={validDataRange ? `${API_BASE_URL}/api/data/export?format=csv&${exportQuery}` : undefined}>导出范围 CSV 压缩包</a>
                <a href={`${API_BASE_URL}/api/data/backup`}>下载 SQLite 备份</a>
                <button
                  type="button"
                  disabled={props.deletingData || !validDataRange}
                  onClick={() => {
                    if (confirmDelete(
                      `确定删除 ${dataFrom} 至 ${dataTo} 的本地记录吗？`,
                      '请再次确认：该日期范围内的应用、域名、状态和调试事件将永久删除。',
                    )) {
                      void props.onDeleteData({ from: dataFrom, to: dataTo, all: false })
                    }
                  }}
                >删除范围数据</button>
                <button
                  type="button"
                  className="is-danger"
                  disabled={props.deletingData}
                  onClick={() => {
                    if (confirmDelete(
                      '确定删除 Timeline 的全部本地活动数据吗？',
                      '最后确认：全部历史记录和统计将永久删除，配置文件不会删除。',
                    )) {
                      void props.onDeleteData({ all: true })
                    }
                  }}
                >删除全部数据</button>
              </div>
            </div>
          </section>
        </div>

        {/* Monitors */}
        <div className="settings-winui-side">
          <section className="settings-winui-section">
            <h2 className="settings-winui-section-title">监视器</h2>
            <div className="settings-winui-card">
              <div className="settings-winui-card-subtitle">各采集模块的运行状态</div>
              <div className="monitor-list">
                {props.loading ? (
                  <MonitorListSkeleton />
                ) : (
                  props.agentSettings?.monitors.map((monitor) => (
                    <article key={monitor.key} className={`monitor-card is-${monitor.status}`}>
                      <div className="monitor-card-status-bar" aria-hidden="true" />
                      <div className="monitor-card-body">
                        <div className="monitor-head">
                          <strong>{monitor.label}</strong>
                          <span className={`monitor-badge is-${monitor.status}`}>{monitorStatusLabel(monitor.status)}</span>
                        </div>
                        <p>{monitor.detail}</p>
                        <small>
                          {monitor.last_seen ? `最后活跃 ${new Date(monitor.last_seen).toLocaleTimeString()}` : '等待首次心跳'}
                        </small>
                        {monitor.last_error ? <small className="settings-error">最近错误：{monitor.last_error}</small> : null}
                      </div>
                    </article>
                  )) ?? <div className="empty-card">读取中…</div>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </section>
  )
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
        <div className="settings-winui-divider" />
        <div className="settings-winui-row settings-time-window-row">
          <div>
            <div className="settings-winui-row-label">工作时段</div>
            <div className="settings-winui-row-desc">启用后仅在这个本地时间范围内提醒</div>
          </div>
          <div className="settings-winui-row-control settings-time-window-control">
            <label className="settings-config-check">
              <input
                type="checkbox"
                aria-label="限制提醒到工作时段"
                checked={values.healthReminderWorkHoursEnabled}
                disabled={!values.healthReminderEnabled}
                onChange={(event) =>
                  patchValues({ healthReminderWorkHoursEnabled: event.target.checked })}
              />
              <span className="toggle-switch-text">
                {values.healthReminderWorkHoursEnabled ? '限制' : '全天'}
              </span>
            </label>
            <div className="settings-time-range">
              <input
                type="time"
                aria-label="工作时段开始时间"
                value={values.healthReminderWorkStart}
                disabled={!values.healthReminderEnabled || !values.healthReminderWorkHoursEnabled}
                onChange={(event) =>
                  patchValues({ healthReminderWorkStart: event.target.value })}
              />
              <span>至</span>
              <input
                type="time"
                aria-label="工作时段结束时间"
                value={values.healthReminderWorkEnd}
                disabled={!values.healthReminderEnabled || !values.healthReminderWorkHoursEnabled}
                onChange={(event) => patchValues({ healthReminderWorkEnd: event.target.value })}
              />
            </div>
          </div>
        </div>
        <div className="settings-winui-divider" />
        <div className="settings-winui-row settings-time-window-row">
          <div>
            <div className="settings-winui-row-label">静默时段</div>
            <div className="settings-winui-row-desc">范围内不提醒，支持例如 22:00 至次日 08:00</div>
          </div>
          <div className="settings-winui-row-control settings-time-window-control">
            <label className="settings-config-check">
              <input
                type="checkbox"
                aria-label="启用静默时段"
                checked={values.healthReminderQuietHoursEnabled}
                disabled={!values.healthReminderEnabled}
                onChange={(event) =>
                  patchValues({ healthReminderQuietHoursEnabled: event.target.checked })}
              />
              <span className="toggle-switch-text">
                {values.healthReminderQuietHoursEnabled ? '启用' : '关闭'}
              </span>
            </label>
            <div className="settings-time-range">
              <input
                type="time"
                aria-label="静默时段开始时间"
                value={values.healthReminderQuietStart}
                disabled={!values.healthReminderEnabled || !values.healthReminderQuietHoursEnabled}
                onChange={(event) =>
                  patchValues({ healthReminderQuietStart: event.target.value })}
              />
              <span>至</span>
              <input
                type="time"
                aria-label="静默时段结束时间"
                value={values.healthReminderQuietEnd}
                disabled={!values.healthReminderEnabled || !values.healthReminderQuietHoursEnabled}
                onChange={(event) => patchValues({ healthReminderQuietEnd: event.target.value })}
              />
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
        {props.settings.recent_apps.length > 0 ? (
          <div className="settings-recent-picker" aria-label="最近应用">
            <span>最近应用</span>
            <div>
              {props.settings.recent_apps.map((item) => {
                const included = configListIncludes(values.ignoredAppsText, item.key)
                return (
                  <button
                    key={item.key}
                    type="button"
                    disabled={included}
                    title={item.key}
                    aria-label={`${included ? '已忽略' : '忽略应用'} ${item.label}`}
                    onClick={() =>
                      patchValues({
                        ignoredAppsText: appendConfigListItem(values.ignoredAppsText, item.key),
                      })}
                  >
                    {included ? '✓' : '+'} {item.label}
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}
        <label className="settings-config-field is-wide">
          <span>忽略域名（每行一个，如 example.com）</span>
          <textarea
            rows={4}
            value={values.ignoredDomainsText}
            onChange={(event) => patchValues({ ignoredDomainsText: event.target.value })}
          />
        </label>
        {props.settings.recent_domains.length > 0 ? (
          <div className="settings-recent-picker" aria-label="最近域名">
            <span>最近域名</span>
            <div>
              {props.settings.recent_domains.map((item) => {
                const included = configListIncludes(values.ignoredDomainsText, item.key)
                return (
                  <button
                    key={item.key}
                    type="button"
                    disabled={included}
                    aria-label={`${included ? '已忽略' : '忽略域名'} ${item.label}`}
                    onClick={() =>
                      patchValues({
                        ignoredDomainsText: appendConfigListItem(values.ignoredDomainsText, item.key),
                      })}
                  >
                    {included ? '✓' : '+'} {item.label}
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}
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
      {Array.from({ length: 3 }, (_, index) => (
        <article key={`monitor-skeleton-${index}`} className="monitor-card monitor-card-skeleton">
          <div className="monitor-card-status-bar" aria-hidden="true" />
          <div className="monitor-card-body">
            <div className="monitor-head">
              <span className="skeleton-block skeleton-inline skeleton-monitor-title" />
              <span className="skeleton-block skeleton-inline skeleton-monitor-badge" />
            </div>
            <span className="skeleton-block skeleton-inline skeleton-monitor-line" />
            <span className="skeleton-block skeleton-inline skeleton-monitor-line skeleton-monitor-line-short" />
          </div>
        </article>
      ))}
    </>
  )
}
