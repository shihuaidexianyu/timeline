import { getConnectionState, setConnectionState } from './state.js'

const status = document.querySelector('#status')
const agent = document.querySelector('#agent')
const domain = document.querySelector('#domain')
const lastSuccess = document.querySelector('#last-success')
const error = document.querySelector('#error')
const tracking = document.querySelector('#tracking')
let state

void refresh()
tracking.addEventListener('click', () => void toggleTracking())

async function refresh() {
  state = await getConnectionState()
  status.textContent = state.paused ? '已暂停' : state.status === 'online' ? '在线' : '离线'
  agent.textContent = state.agentBaseUrl ?? '尚未发现'
  domain.textContent = state.currentDomain ?? '当前页面不记录'
  lastSuccess.textContent = state.lastSuccessAt ? new Date(state.lastSuccessAt).toLocaleString() : '--'
  error.textContent = state.lastError ?? ''
  tracking.textContent = state.paused ? '恢复采集' : '暂停 15 分钟'
  tracking.disabled = !state.agentBaseUrl
}

async function toggleTracking() {
  tracking.disabled = true
  error.textContent = ''
  try {
    const path = state.paused ? '/api/tracking/resume' : '/api/tracking/pause'
    const body = state.paused ? {} : { duration_secs: 900 }
    const response = await fetch(`${state.agentBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Timeline-Extension': 'browser-bridge',
      },
      body: JSON.stringify(body),
    })
    const result = await response.json()
    if (!response.ok || !result.ok) throw new Error(result.error?.message ?? '操作失败')
    await setConnectionState({ paused: result.data.tracking_paused })
  } catch (cause) {
    error.textContent = cause instanceof Error ? cause.message : '无法连接本地服务'
  }
  await refresh()
}
