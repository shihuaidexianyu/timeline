export function buildPayload(tab, now = new Date()) {
  if (!tab?.url || !Number.isInteger(tab.windowId) || !Number.isInteger(tab.id)) return null
  let url
  try {
    url = new URL(tab.url)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const domain = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!domain || domain.length > 253) return null
  return {
    domain,
    page_title: typeof tab.title === 'string' ? tab.title.slice(0, 512) : null,
    browser_window_id: tab.windowId,
    tab_id: tab.id,
    observed_at: now.toISOString(),
  }
}

export function isLoopbackHttpUrl(value) {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

export function reportSignature(payload) {
  return `${payload.domain}|${payload.browser_window_id}|${payload.tab_id}`
}

export function createReportDeduper(windowMs, now = () => Date.now()) {
  let lastSignature = null
  let lastReportedAt = 0
  return {
    shouldSkip(payload, reason) {
      if (reason === 'heartbeat') return false
      const signature = reportSignature(payload)
      const reportedAt = now()
      const duplicate = signature === lastSignature && reportedAt - lastReportedAt < windowMs
      lastSignature = signature
      lastReportedAt = reportedAt
      return duplicate
    },
  }
}
