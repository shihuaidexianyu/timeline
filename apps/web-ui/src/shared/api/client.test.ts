import { describe, expect, it } from 'vitest'
import { readApiEnvelope } from './client'

describe('api client', () => {
  it('normalizes invalid envelopes', async () => {
    const response = new Response('not json', { status: 502 })
    const envelope = await readApiEnvelope<{ value: number }>(response)

    expect(envelope.ok).toBe(false)
    expect(envelope.data).toBeNull()
    expect(envelope.error?.message).toContain('HTTP 502')
  })

  it('parses valid envelopes', async () => {
    const response = new Response(JSON.stringify({ ok: true, data: { value: 1 }, error: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    const envelope = await readApiEnvelope<{ value: number }>(response)

    expect(envelope.ok).toBe(true)
    expect(envelope.data).toEqual({ value: 1 })
  })
})
