import 'server-only'

/**
 * Rate Governor — deterministic pacing layer in front of the free Z.ai tier.
 *
 * Responsibilities (no AI involved):
 * - Enforce a minimum gap between request starts (smooths bursts)
 * - Enforce a rolling 60s request budget (default 12/min, env-tunable)
 * - Circuit breaker: after repeated transient (429/overload) failures, enter a
 *   cooldown so callers get an immediate "busy" signal with retryAfter instead
 *   of piling onto a struggling upstream.
 *
 * Note: this governor is per serverless instance. In practice the serial queue
 * + governor on one warm instance is what absorbs the class's load; across
 * instances it is best-effort smoothing, with upstream retries as the net.
 */

export class BusyError extends Error {
  retryAfterSec: number
  constructor(retryAfterSec: number, message?: string) {
    super(message ?? 'Model capacity is busy. Please wait and retry.')
    this.name = 'BusyError'
    this.retryAfterSec = retryAfterSec
  }
}

const WINDOW_MS = 60_000
const BREAKER_THRESHOLD = 3
const BREAKER_COOLDOWN_MS = 40_000
const MAX_WAIT_MS = 35_000 // keep callers inside serverless maxDuration budget

/**
 * Upstream key pool: ZAI_API_KEY plus optional ZAI_API_KEY_2..ZAI_API_KEY_9.
 * Keys from DIFFERENT accounts each bring their own free-tier bucket, so N
 * keys multiply capacity (free glm-4.7-flash = 1 in-flight per account/model).
 * Keys are never logged and never returned by any API.
 */
export function upstreamKeys(): string[] {
  const list = [
    process.env.ZAI_API_KEY,
    process.env.ZAI_API_KEY_2,
    process.env.ZAI_API_KEY_3,
    process.env.ZAI_API_KEY_4,
    process.env.ZAI_API_KEY_5,
    process.env.ZAI_API_KEY_6,
    process.env.ZAI_API_KEY_7,
    process.env.ZAI_API_KEY_8,
    process.env.ZAI_API_KEY_9,
  ]
  const keys: string[] = []
  for (const k of list) {
    const v = (k ?? '').trim()
    if (v) keys.push(v)
  }
  return keys
}

const KEY_COUNT = Math.max(1, upstreamKeys().length)

// Pool scales the per-account limits: each key has its own RPM budget and its
// own 2s breathing gap, so the GLOBAL arrival rate multiplies by key count.
const WINDOW_MAX = Math.max(2, (Number(process.env.ZAI_RPM_LIMIT) || 12) * KEY_COUNT)
const MIN_GAP_MS = Math.max(250, Math.floor((Number(process.env.ZAI_MIN_GAP_MS) || 2_000) / KEY_COUNT))

/** In-flight cap: one concurrent upstream request per key (free-tier reality). ZAI_CONCURRENCY overrides. */
export const concurrencyLimit = (): number => {
  const env = Number(process.env.ZAI_CONCURRENCY) || 0
  return env > 0 ? env : KEY_COUNT
}

let lastStartAt = 0
let windowStamps: number[] = []
let breakerUntil = 0
let consecutiveTransient = 0
let inflight = 0
let rr = 0
const keyCooldown = new Map<string, number>()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function windowCount(now: number): number {
  windowStamps = windowStamps.filter((t) => now - t < WINDOW_MS)
  return windowStamps.length
}

/** ms to wait until the rolling window has capacity */
function windowWaitMs(now: number): number {
  if (windowCount(now) < WINDOW_MAX) return 0
  const oldest = Math.min(...windowStamps)
  return Math.max(0, oldest + WINDOW_MS - now + 50)
}

/**
 * Acquire a slot. Resolves when the caller may start an upstream request.
 * Throws BusyError(retryAfterSec) when the wait would exceed the serverless
 * time budget or the breaker is open — clients treat this as "pause & retry".
 */
export async function acquire(): Promise<void> {
  const now0 = Date.now()
  if (now0 < breakerUntil) {
    throw new BusyError(Math.ceil((breakerUntil - now0) / 1000) + 2, 'Model capacity is cooling down after repeated upstream load.')
  }

  let waited = 0
  for (;;) {
    const t = Date.now()
    if (t < breakerUntil) {
      // breaker opened while waiting
      throw new BusyError(Math.ceil((breakerUntil - t) / 1000) + 2, 'Model capacity is cooling down after repeated upstream load.')
    }
    const gapWait = lastStartAt > 0 ? Math.max(0, lastStartAt + MIN_GAP_MS - t) : 0
    const winWait = windowWaitMs(t)
    const slotWait = inflight >= concurrencyLimit() ? 1_500 : 0
    const wait = Math.max(gapWait, winWait, slotWait)
    if (wait === 0) {
      inflight++
      lastStartAt = t
      windowStamps.push(t)
      return
    }
    if (waited + wait > MAX_WAIT_MS) {
      throw new BusyError(Math.ceil(wait / 1000), 'Request queue is full for this minute — retry shortly.')
    }
    await sleep(wait)
    waited += wait
  }
}

/** Free the in-flight slot taken by acquire(). Call in a finally block. */
export function release(): void {
  inflight = Math.max(0, inflight - 1)
}

/** Record the outcome of an upstream attempt for breaker bookkeeping. */
export function noteUpstreamResult(ok: boolean, retryAfterSec?: number): void {
  if (ok) {
    consecutiveTransient = 0
    return
  }
  consecutiveTransient++
  if (retryAfterSec && retryAfterSec > 0) {
    breakerUntil = Math.max(breakerUntil, Date.now() + Math.min(retryAfterSec, 90) * 1000)
  }
  if (consecutiveTransient >= BREAKER_THRESHOLD) {
    breakerUntil = Math.max(breakerUntil, Date.now() + BREAKER_COOLDOWN_MS)
    consecutiveTransient = 0
  }
}

/** Open the breaker proactively (e.g., upstream said Retry-After). */
export function penalize(retryAfterSec: number): void {
  breakerUntil = Math.max(breakerUntil, Date.now() + Math.min(retryAfterSec, 90) * 1000)
}

/**
 * Round-robin the key pool, skipping keys in per-key cooldown when possible.
 * Each upstream attempt picks fresh — a busy key is silently swapped for a
 * healthy one inside the same request.
 */
export function pickKey(): string | undefined {
  const keys = upstreamKeys()
  if (keys.length === 0) return undefined
  const now = Date.now()
  const fresh = keys.filter((k) => (keyCooldown.get(k) ?? 0) <= now)
  const pool = fresh.length > 0 ? fresh : keys
  if (rr >= pool.length) rr = 0
  const key = pool[rr % pool.length]
  rr = (rr + 1) % Math.max(1, pool.length)
  return key
}

/** Cool one key down after its account was rejected (429/overload). */
export function penalizeKey(key: string | undefined, sec = 20): void {
  if (!key) return
  if (keyCooldown.size > 500) keyCooldown.clear() // bounded: drop stale user-key entries
  keyCooldown.set(key, Date.now() + Math.min(Math.max(sec, 10), 90) * 1000)
}

export function snapshot(): {
  windowMax: number
  windowUsed: number
  minGapMs: number
  breakerRemainingSec: number
  concurrency: number
  inflight: number
  keys: number
} {
  const now = Date.now()
  return {
    windowMax: WINDOW_MAX,
    windowUsed: windowCount(now),
    minGapMs: MIN_GAP_MS,
    breakerRemainingSec: Math.max(0, Math.ceil((breakerUntil - now) / 1000)),
    concurrency: concurrencyLimit(),
    inflight,
    keys: upstreamKeys().length,
  }
}
