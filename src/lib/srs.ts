import type { CardProgress } from './types'

const MINUTE = 60_000
const DAY = 86_400_000
const MIN_EASE = 1.3
const MAX_EASE = 3.2
const LEARN_STEP = 10 * MINUTE

export type Rating = 0 | 1 | 2 | 3 // again, hard, good, easy

export function newProgress(): CardProgress {
  return { reps: 0, ease: 2.5, interval: 0, due: 0, lapses: 0 }
}

/** SM-2 inspired scheduler with Anki-like learning steps. */
export function rateCard(p: CardProgress, q: Rating, now = Date.now()): CardProgress {
  const next: CardProgress = { ...p }

  if (q === 0) {
    next.lapses = p.lapses + 1
    next.reps = 0
    next.ease = Math.max(MIN_EASE, p.ease - 0.2)
    next.interval = 0
    next.due = now + LEARN_STEP
    next.last = now
    return next
  }

  next.reps = p.reps + 1
  const reps = next.reps

  if (q === 1) {
    next.ease = Math.max(MIN_EASE, p.ease - 0.15)
    next.interval = reps === 1 ? 0.5 : Math.max(p.interval * 1.2, 1)
  } else if (q === 2) {
    next.interval = reps === 1 ? 1 : reps === 2 ? 3 : Math.max(p.interval, 1) * p.ease
  } else {
    next.ease = Math.min(MAX_EASE, p.ease + 0.15)
    next.interval = reps === 1 ? 3 : Math.max(p.interval, 1) * p.ease * 1.3
  }

  next.interval = Math.round(next.interval * 100) / 100
  next.due = now + Math.round(next.interval * DAY)
  next.last = now
  return next
}

/** Human label for the next interval at a given rating, e.g. "10m", "1.2d", "3d". */
export function intervalLabel(p: CardProgress, q: Rating, now = Date.now()): string {
  const n = rateCard(p, q, now)
  const ms = n.due - now
  if (ms < DAY) return `${Math.max(1, Math.round(ms / MINUTE))}m`
  const days = ms / DAY
  if (days < 31) return `${Math.round(days)}d`
  return `${(days / 30.44).toFixed(1)}mo`
}

export function isDue(p: CardProgress, now = Date.now()): boolean {
  return p.due <= now
}

export function isNew(p: CardProgress): boolean {
  return p.reps === 0 && p.lapses === 0
}

/** Count due (review + learning) and new cards in a deck. */
export function deckStats(deck: { cards: Array<{ progress: CardProgress }> }, now = Date.now()) {
  let due = 0
  let fresh = 0
  for (const c of deck.cards) {
    if (isNew(c.progress)) fresh++
    else if (isDue(c.progress, now)) due++
  }
  return { due, fresh, total: deck.cards.length }
}
