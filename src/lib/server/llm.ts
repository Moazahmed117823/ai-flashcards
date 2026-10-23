import 'server-only'
import * as governor from './governor'

const API_URL = 'https://api.z.ai/api/paas/v4/chat/completions'

export type Msg = { role: 'system' | 'user' | 'assistant'; content: string }

/** Upstream error carrying the server-suggested Retry-After (seconds), if any. */
export class UpstreamError extends Error {
  retryAfterSec?: number
  constructor(message: string, retryAfterSec?: number) {
    super(message)
    this.name = 'UpstreamError'
    this.retryAfterSec = retryAfterSec
  }
}

/**
 * Free-tier friendly serial queue (GLM Flash models allow ~1 concurrent
 * request). All generation work funnels through here; anything past the
 * cap gets a 429 so the client can retry.
 */
let chain: Promise<unknown> = Promise.resolve()
let pending = 0
const MAX_QUEUE = 12

export const queueSnapshot = (): number => pending

export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  if (pending >= MAX_QUEUE) {
    return Promise.reject(new QueueFullError()) as Promise<T>
  }
  pending++
  const run = chain.then(fn, fn)
  chain = run.catch(() => undefined)
  return run.finally(() => {
    pending--
  }) as Promise<T>
}

export class QueueFullError extends Error {
  constructor() {
    super('Generation queue is full. Please retry in ~30 seconds.')
    this.name = 'QueueFullError'
  }
}

const TRANSIENT_ERROR = /\b429\b|overload|temporarily|rate limit/i

/** True when an error message looks like free-tier saturation (429/overload). */
export const isTransientMessage = (msg: string): boolean => TRANSIENT_ERROR.test(msg)

/**
 * Retry transient free-tier failures (429 / overload) with short backoff,
 * reporting every outcome to the rate governor (feeds the circuit breaker).
 * `budgetMs` caps total time so the 60s serverless function never times out.
 */
async function withTransientRetry<T>(fn: () => Promise<T>, budgetMs = 54_000): Promise<T> {
  const waits = [0, 4_000, 9_000]
  const start = Date.now()
  let lastErr: unknown
  for (const w of waits) {
    if (w > 0) {
      // never start another attempt unless the remaining function budget allows it
      if (Date.now() - start + w + 12_000 > budgetMs) break
      await new Promise((r) => setTimeout(r, w))
    }
    try {
      const out = await fn()
      governor.noteUpstreamResult(true)
      return out
    } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : String(e)
      if (TRANSIENT_ERROR.test(msg)) {
        const ra = e instanceof UpstreamError && e.retryAfterSec ? e.retryAfterSec : undefined
        governor.noteUpstreamResult(false, ra)
        if (ra && ra >= 10) governor.penalize(ra)
      }
      if (!TRANSIENT_ERROR.test(msg)) throw e
    }
  }
  throw lastErr
}

/** Pull the first balanced JSON object out of arbitrary model output. */
export function extractJson(raw: string): Record<string, unknown> {
  let t = raw.trim()
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')
  const s = t.indexOf('{')
  const e = t.lastIndexOf('}')
  if (s === -1 || e === -1 || e <= s) throw new Error('No JSON object found in model output.')
  let body = t.slice(s, e + 1)
  try {
    return JSON.parse(body) as Record<string, unknown>
  } catch {
    // common LLM slip: trailing commas
    body = body.replace(/,\s*([}\]])/g, '$1')
    return JSON.parse(body) as Record<string, unknown>
  }
}

async function callWithEnvKey(messages: Msg[], jsonMode: boolean, keyOverride?: string): Promise<string> {
  const key = keyOverride || (process.env.ZAI_API_KEY as string)
  const model = (process.env.ZAI_MODEL as string) || 'glm-4.7-flash'
  const thinking = (process.env.ZAI_THINKING as string) || 'disabled'

  const body: Record<string, unknown> = { model, messages, temperature: 0.3 }
  if (thinking === 'enabled') body.thinking = { type: 'enabled' }
  if (jsonMode) body.response_format = { type: 'json_object' }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(40_000),
  })

  if (!res.ok) {
    const text = await res.text()
    if (res.status === 400 && jsonMode) return callWithEnvKey(messages, false) // endpoint may not support response_format
    let msg = `Model API error ${res.status}`
    try {
      const j = JSON.parse(text) as { error?: { message?: string } }
      if (j?.error?.message) msg += `: ${j.error.message}`
    } catch {
      msg += `: ${text.slice(0, 200)}`
    }
    const raRaw = res.headers.get('retry-after')
    const raSec = raRaw ? Number(raRaw) : undefined
    throw new UpstreamError(msg, Number.isFinite(raSec) ? raSec : undefined)
  }

  const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return j?.choices?.[0]?.message?.content ?? ''
}

/**
 * Sandbox/demo fallback via z-ai-web-dev-sdk when no env key is set.
 * Uses an un-analyzable dynamic import so the app builds (and the env
 * path works) even on hosts where the SDK is not installed.
 */
async function callSdk(messages: Msg[]): Promise<string> {
  const dynImport = new Function('m', 'return import(m)') as (m: string) => Promise<Record<string, unknown>>
  const mod = await dynImport('z-ai-web-dev-sdk')
  const factory = (mod.default ?? mod) as {
    create: () => Promise<{
      chat: { completions: { create: (o: unknown) => Promise<{ choices?: Array<{ message?: { content?: string } }> }> } }
    }>
  }
  const zai = await factory.create()
  const res = await zai.chat.completions.create({ messages })
  return res?.choices?.[0]?.message?.content ?? ''
}

/** userKey (optional) lets a visitor supply their own Z.ai key per-request. */
export async function chat(messages: Msg[], userKey?: string): Promise<string> {
  const entered = Date.now()
  await governor.acquire() // deterministic pacing — throws BusyError when the budget/breaker says wait
  // The queue wait counts against this function's 60s Vercel cap. If it ate
  // most of the window, refuse politely (busy) instead of risking a 504.
  const budgetMs = 54_000 - (Date.now() - entered)
  if (budgetMs < 15_000) {
    throw new governor.BusyError(12, 'Queue wait used this request window — starting fresh in a few seconds.')
  }
  try {
    if (userKey) return await withTransientRetry(() => callWithEnvKey(messages, true, userKey), budgetMs)
    if (process.env.ZAI_API_KEY) return await withTransientRetry(() => callWithEnvKey(messages, true), budgetMs)
    try {
      return await callSdk(messages)
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      throw new Error(
        `No model backend available. Add a ZAI_API_KEY environment variable (free key from the Z.ai API platform). [${detail}]`,
      )
    }
  } catch (e) {
    if (e instanceof governor.BusyError) throw e
    throw e
  }
}

export { governor }
