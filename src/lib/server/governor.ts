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
const WINDOW_MAX = Math.max(2, Number(process.env.ZAI_RPM_LIMIT) || 12)
const MIN_GAP_MS = Math.max(250, Number(process.env.ZAI_MIN_GAP_MS) || 2_000)
const BREAKER_THRESHOLD = 3
const BREAKER_COOLDOWN_MS = 40_000
const MAX_WAIT_MS = 35_000 // keep callers inside serverless maxDuration budget

let lastStartAt = 0
let windowStamps: number[] = []
let breakerUntil = 0
let consecutiveTransient = 0

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
  const now = Date.now()
  if (now < breakerUntil) {
    throw new BusyError(Math.ceil((breakerUntil - now) / 1000) + 2, 'Model capacity is cooling down after repeated upstream load.')
  }

  let waited = 0
  for (;;) {
    const t = Date.now()
    if (t >= breakerUntil) {
      const gapWait = lastStartAt > 0 ? Math.max(0, lastStartAt + MIN_GAP_MS - t) : 0
      const winWait = windowWaitMs(t)
      const wait = Math.max(gapWait, winWait)
      if (wait === 0) {
        lastStartAt = t
        windowStamps.push(t)
        return
      }
      if (waited + wait > MAX_WAIT_MS) {
        throw new BusyError(Math.ceil(wait / 1000), 'Request queue is full for this minute — retry shortly.')
      }
      await sleep(wait)
      waited += wait
      continue
    }
    // breaker opened while waiting
    throw new BusyError(Math.ceil((breakerUntil - Date.now()) / 1000) + 2, 'Model capacity is cooling down after repeated upstream load.')
  }
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

export function snapshot(): { windowMax: number; windowUsed: number; minGapMs: number; breakerRemainingSec: number } {
  const now = Date.now()
  return {
    windowMax: WINDOW_MAX,
    windowUsed: windowCount(now),
    minGapMs: MIN_GAP_MS,
    breakerRemainingSec: Math.max(0, Math.ceil((breakerUntil - now) / 1000)),
  }
}
