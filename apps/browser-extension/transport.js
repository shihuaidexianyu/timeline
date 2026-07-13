import { rememberAgentBaseUrl } from './discovery.js'
import { setConnectionState } from './state.js'

export function createReportTransport(options = {}) {
  const postEvent = options.postEvent ?? postBrowserEvent
  const rememberBaseUrl = options.rememberBaseUrl ?? rememberAgentBaseUrl
  const updateConnection = options.updateConnection ?? setConnectionState
  const waitFor = options.waitFor ?? wait
  const jitter = options.jitter ?? withJitter
  const nowIso = options.nowIso ?? (() => new Date().toISOString())
  const retryDelays = options.retryDelays ?? [0, 300, 1200, 4000]
  let consecutiveFailures = 0
  let sequence = 0
  let draining = false
  const pending = []

  function enqueueReport(payload, baseUrls) {
    return new Promise((resolve, reject) => {
      pending.push({ payload, baseUrls, resolve, reject, sequence: sequence++ })
      pending.sort(comparePendingReports)
      if (!draining) queueMicrotask(drain)
    })
  }

  async function drain() {
    if (draining) return
    draining = true
    try {
      while (pending.length > 0) {
        const report = pending.shift()
        try {
          report.resolve(await sendWithRetry(report.payload, report.baseUrls))
        } catch (error) {
          report.reject(error)
        }
      }
    } finally {
      draining = false
      if (pending.length > 0) queueMicrotask(drain)
    }
  }

  async function sendWithRetry(payload, baseUrls) {
    for (const delay of retryDelays) {
      if (delay > 0) await waitFor(jitter(delay))
      for (const baseUrl of baseUrls) {
        const result = await postEvent(baseUrl, payload)
        if (result.kind === 'network_error') continue
        if (result.kind === 'success') {
          consecutiveFailures = 0
          await rememberBaseUrl(baseUrl)
          await updateConnection({
            status: 'online',
            agentBaseUrl: baseUrl,
            currentDomain: payload.domain,
            lastSuccessAt: nowIso(),
            paused: false,
            lastError: null,
          })
        } else {
          await updateConnection({
            status: result.paused ? 'paused' : 'online',
            agentBaseUrl: baseUrl,
            currentDomain: payload.domain,
            paused: result.paused,
            lastError: result.reason,
          })
        }
        return result
      }
    }
    consecutiveFailures += 1
    await updateConnection({
      status: 'offline',
      paused: false,
      lastError: `连接失败（连续 ${consecutiveFailures} 次）`,
    })
    return { kind: 'network_error' }
  }

  return { enqueueReport }
}

const defaultTransport = createReportTransport()

export function enqueueReport(payload, baseUrls) {
  return defaultTransport.enqueueReport(payload, baseUrls)
}

export async function postBrowserEvent(baseUrl, payload) {
  try {
    const response = await fetch(`${baseUrl}/api/events/browser`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Timeline-Extension': 'browser-bridge',
      },
      body: JSON.stringify(payload),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok || !body?.ok || body.data?.accepted === false) {
      return {
        kind: 'rejected',
        status: response.status,
        paused: body?.data?.reason === 'tracking is paused',
        reason: body?.data?.reason ?? body?.error?.message ?? '事件被本地服务拒绝',
      }
    }
    return { kind: 'success', status: response.status }
  } catch (error) {
    return { kind: 'network_error', error }
  }
}

function comparePendingReports(left, right) {
  const leftTime = Date.parse(left.payload.observed_at)
  const rightTime = Date.parse(right.payload.observed_at)
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime
  }
  return left.sequence - right.sequence
}

function withJitter(delay) {
  return Math.round(delay * (0.8 + Math.random() * 0.4))
}

function wait(delay) {
  return new Promise((resolve) => setTimeout(resolve, delay))
}
