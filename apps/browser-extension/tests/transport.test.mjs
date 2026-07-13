import test from 'node:test'
import assert from 'node:assert/strict'
import { createReportTransport, postBrowserEvent } from '../transport.js'

test('serial queue orders pending reports by observed time', async () => {
  const sent = []
  let activeSends = 0
  let maxActiveSends = 0
  const transport = createReportTransport({
    retryDelays: [0],
    postEvent: async (_baseUrl, payload) => {
      activeSends += 1
      maxActiveSends = Math.max(maxActiveSends, activeSends)
      await Promise.resolve()
      sent.push(payload.domain)
      activeSends -= 1
      return { kind: 'success', status: 200 }
    },
    rememberBaseUrl: async () => true,
    updateConnection: async () => {},
  })

  const later = transport.enqueueReport(payload('later.test', '2026-07-13T02:00:00Z'), ['local'])
  const earlier = transport.enqueueReport(payload('earlier.test', '2026-07-13T01:00:00Z'), ['local'])
  await Promise.all([later, earlier])

  assert.deepEqual(sent, ['earlier.test', 'later.test'])
  assert.equal(maxActiveSends, 1)
})

test('network errors retry with configured backoff and then recover', async () => {
  let attempts = 0
  const waits = []
  const states = []
  const transport = createReportTransport({
    retryDelays: [0, 10, 20],
    jitter: (delay) => delay,
    waitFor: async (delay) => waits.push(delay),
    postEvent: async () => {
      attempts += 1
      return attempts < 3
        ? { kind: 'network_error' }
        : { kind: 'success', status: 200 }
    },
    rememberBaseUrl: async () => true,
    updateConnection: async (state) => states.push(state),
    nowIso: () => '2026-07-13T03:00:00.000Z',
  })

  const result = await transport.enqueueReport(payload('retry.test'), ['local'])
  assert.equal(result.kind, 'success')
  assert.equal(attempts, 3)
  assert.deepEqual(waits, [10, 20])
  assert.equal(states.at(-1).status, 'online')
  assert.equal(states.at(-1).lastSuccessAt, '2026-07-13T03:00:00.000Z')
})

test('agent rejection is not retried and preserves paused state', async () => {
  let attempts = 0
  const states = []
  const transport = createReportTransport({
    retryDelays: [0, 1, 2],
    postEvent: async () => {
      attempts += 1
      return { kind: 'rejected', paused: true, reason: 'tracking is paused' }
    },
    updateConnection: async (state) => states.push(state),
  })
  const result = await transport.enqueueReport(payload('paused.test'), ['local'])
  assert.equal(result.kind, 'rejected')
  assert.equal(attempts, 1)
  assert.equal(states[0].status, 'paused')
})

test('HTTP transport sends only hostname payload with extension header', async () => {
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (url, options) => {
    request = { url, options }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: { accepted: true }, error: null }),
    }
  }
  try {
    const report = payload('header.test')
    const result = await postBrowserEvent('http://127.0.0.1:46215', report)
    assert.equal(result.kind, 'success')
    assert.equal(request.options.headers['X-Timeline-Extension'], 'browser-bridge')
    assert.deepEqual(JSON.parse(request.options.body), report)
  } finally {
    globalThis.fetch = originalFetch
  }
})

function payload(domain, observedAt = '2026-07-13T01:00:00Z') {
  return {
    domain,
    page_title: null,
    browser_window_id: 1,
    tab_id: 2,
    observed_at: observedAt,
  }
}
