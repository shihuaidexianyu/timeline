import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPayload,
  createReportDeduper,
  isLoopbackHttpUrl,
  reportSignature,
} from '../validation.js'

test('only reports http and https hostnames without URL paths', () => {
  const now = new Date('2026-07-13T01:02:03Z')
  const payload = buildPayload({
    id: 7,
    windowId: 8,
    url: 'https://Example.COM/private?q=secret',
    title: 'Example',
  }, now)
  assert.deepEqual(payload, {
    domain: 'example.com',
    page_title: 'Example',
    browser_window_id: 8,
    tab_id: 7,
    observed_at: '2026-07-13T01:02:03.000Z',
  })
  assert.equal(buildPayload({ id: 1, windowId: 2, url: 'chrome://settings' }), null)
  assert.equal(buildPayload({ id: 1, windowId: 2, url: 'file:///private.txt' }), null)
})

test('accepts all supported loopback spellings only', () => {
  assert.equal(isLoopbackHttpUrl('http://127.0.0.1:46215'), true)
  assert.equal(isLoopbackHttpUrl('http://localhost:46215'), true)
  assert.equal(isLoopbackHttpUrl('http://[::1]:46215'), true)
  assert.equal(isLoopbackHttpUrl('http://192.168.1.2:46215'), false)
})

test('dedupe signature includes domain window and tab', () => {
  assert.notEqual(
    reportSignature({ domain: 'a.test', browser_window_id: 1, tab_id: 1 }),
    reportSignature({ domain: 'a.test', browser_window_id: 1, tab_id: 2 }),
  )
})

test('dedupe ignores rapid duplicates but never suppresses heartbeats', () => {
  let now = 1_000
  const deduper = createReportDeduper(1_800, () => now)
  const payload = { domain: 'a.test', browser_window_id: 1, tab_id: 1 }
  assert.equal(deduper.shouldSkip(payload, 'activated'), false)
  now += 100
  assert.equal(deduper.shouldSkip(payload, 'updated'), true)
  assert.equal(deduper.shouldSkip(payload, 'heartbeat'), false)
  now += 2_000
  assert.equal(deduper.shouldSkip(payload, 'updated'), false)
})
