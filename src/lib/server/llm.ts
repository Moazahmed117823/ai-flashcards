import 'server-only'

const API_URL = 'https://api.z.ai/api/paas/v4/chat/completions'

export type Msg = { role: 'system' | 'user' | 'assistant'; content: string }

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
    signal: AbortSignal.timeout(55_000),
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
    throw new Error(msg)
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
  if (userKey) return callWithEnvKey(messages, true, userKey)
  if (process.env.ZAI_API_KEY) return callWithEnvKey(messages, true)
  try {
    return await callSdk(messages)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    throw new Error(
      `No model backend available. Add a ZAI_API_KEY environment variable (free key from the Z.ai API platform). [${detail}]`,
    )
  }
}
