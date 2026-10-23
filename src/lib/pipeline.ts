'use client'

/**
 * Long-file flashcard pipeline — deterministic orchestration, no AI.
 *
 * Flow: chunk (heading-snapped) → [deep: map] → generate per chunk
 * (each chunk = a resumable localStorage checkpoint; precision verify runs
 * per chunk) → code-based dedupe → [deep: link integration cards] → draft.
 *
 * The LLM is only used inside /api/generate, /api/verify, /api/map, /api/link.
 */

import type {
  DeckMeta,
  Difficulty,
  Draft,
  GeneratedCard,
  MapResult,
  PipelineCheckpoint,
  PipelineChunk,
  PipelineOptions,
  PipelineProgress,
} from './types'
import { uid } from './types'

/* ============================ chunking ============================ */

const HEADING_PATTERNS: RegExp[] = [
  /^#{1,6}\s+\S/, // markdown
  /^(chapter|lecture|section|unit|part|topic|session)\s+\w/i,
  /^\d+(\.\d+)*[).:]?\s+[A-Z\u0600-\u06FF]/, // numbered heading
  /^[A-Z0-9][A-Z0-9\s&/,()-]{5,60}$/, // ALL CAPS
  /^.{2,60}:$/, // "Title:" short line
]

function looksLikeHeading(line: string): boolean {
  const t = line.trim()
  if (t.length < 3 || t.length > 80) return false
  if (t.endsWith('.') || /[.;!?]$/.test(t)) return /^.{2,60}:$/.test(t) ? true : false
  return HEADING_PATTERNS.some((re) => re.test(t))
}

function difficultyChunkTarget(difficulty: Difficulty): number {
  // characters per chunk — hard needs tighter focus
  switch (difficulty) {
    case 'hard':
      return 5_000
    case 'easy':
      return 9_000
    default:
      return 7_000
  }
}

function splitOversized(text: string, max: number): string[] {
  if (text.length <= max) return [text]
  const out: string[] = []
  let buf = ''
  for (const para of text.split(/\n{2,}/)) {
    if ((buf + '\n\n' + para).length > max && buf) {
      out.push(buf)
      buf = para
    } else {
      buf = buf ? `${buf}\n\n${para}` : para
    }
    while (buf.length > max * 1.5) {
      out.push(buf.slice(0, max))
      buf = buf.slice(max)
    }
  }
  if (buf.trim()) out.push(buf)
  return out
}

export function buildChunks(source: string, difficulty: Difficulty): PipelineChunk[] {
  const target = difficultyChunkTarget(difficulty)
  const max = Math.round(target * 1.6)

  // group lines into (heading?) blocks
  const lines = source.split('\n')
  const blocks: Array<{ heading: string | null; text: string }> = []
  let curHeading: string | null = null
  let buf: string[] = []

  const flush = () => {
    const text = buf.join('\n').trim()
    if (text) blocks.push({ heading: curHeading, text })
    buf = []
  }

  for (const line of lines) {
    if (looksLikeHeading(line)) {
      flush()
      curHeading = line.trim().replace(/^#{1,6}\s+/, '').replace(/:$/, '')
    } else {
      buf.push(line)
      if (buf.join('\n').length >= target) flush()
    }
  }
  flush()

  if (blocks.length === 0) return []

  // pack blocks into chunks near target size; keep heading of first block
  const packed: Array<{ heading: string; text: string }> = []
  let packText = ''
  let packHeading = blocks[0].heading ?? 'Part 1'
  for (const b of blocks) {
    const piece = packText ? `${packText}\n\n${b.text}` : b.text
    if (piece.length > target * 1.35 && packText) {
      packed.push({ heading: packHeading, text: packText })
      packText = b.text
      packHeading = b.heading ?? `Continued (${packed.length + 1})`
    } else {
      packText = piece
      if (!packHeading && b.heading) packHeading = b.heading
    }
  }
  if (packText.trim()) packed.push({ heading: packHeading || 'Part 1', text: packText })

  // split any monster chunks, then cap count
  const exploded = packed.flatMap((p) =>
    splitOversized(p.text, max).map((t, k) => ({
      heading: k === 0 ? p.heading : `${p.heading} (cont. ${k + 1})`,
      text: t,
    })),
  )

  const MAX_CHUNKS = 40
  if (exploded.length <= MAX_CHUNKS) {
    return exploded.map((c, i) => ({ i, heading: c.heading, text: c.text }))
  }
  // merge tail chunks to fit the cap
  const per = Math.ceil(exploded.length / MAX_CHUNKS)
  const merged: PipelineChunk[] = []
  for (let i = 0; i < exploded.length; i += per) {
    const group = exploded.slice(i, i + per)
    merged.push({
      i: merged.length,
      heading: group[0].heading,
      text: group.map((g) => g.text).join('\n\n'),
    })
  }
  return merged
}

/* ============================ checkpoints ============================ */

const CP_KEY = 'fc_pipeline_checkpoint_v1'

export function checkpointId(source: string, opts: PipelineOptions): string {
  const seed = `${source.length}|${source.slice(0, 60)}|${source.slice(-60)}|${JSON.stringify(opts)}`
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return `cp_${Math.abs(h).toString(36)}`
}

export function saveCheckpoint(cp: PipelineCheckpoint): void {
  try {
    cp.updatedAt = Date.now()
    localStorage.setItem(CP_KEY, JSON.stringify(cp))
  } catch {
    /* storage full/unavailable — pipeline still runs, just not resumable */
  }
}

export function loadCheckpoint(): PipelineCheckpoint | null {
  try {
    const raw = localStorage.getItem(CP_KEY)
    if (!raw) return null
    const cp = JSON.parse(raw) as PipelineCheckpoint
    return cp && cp.chunks?.length && Array.isArray(cp.cards) ? cp : null
  } catch {
    return null
  }
}

export function clearCheckpoint(): void {
  try {
    localStorage.removeItem(CP_KEY)
  } catch {
    /* ignore */
  }
}

/* ============================ dedupe (code, no AI) ============================ */

const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'is', 'are', 'what', 'which', 'how', 'does', 'do', 'to', 'for', 'and', 'with', 'by'])

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP.has(t)),
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

/** Drop exact + near-duplicate questions (keeps the earlier card). Returns merged count. */
export function dedupeCards(cards: GeneratedCard[]): { cards: GeneratedCard[]; merged: number } {
  const kept: GeneratedCard[] = []
  const keptTokens: Set<string>[] = []
  let merged = 0
  for (const c of cards) {
    const t = tokens(c.question)
    const dup = keptTokens.some((kt) => jaccard(kt, t) >= 0.78)
    if (dup) {
      merged++
      continue
    }
    kept.push(c)
    keptTokens.push(t)
  }
  return { cards: kept, merged }
}

/* ============================ API helpers ============================ */

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  try {
    const k = localStorage.getItem('zai_user_key')
    if (k) headers['x-user-key'] = k
  } catch {
    /* ignore */
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; retryAfter?: number; busy?: boolean }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`) as Error & {
      retryAfter?: number
      busy?: boolean
      status?: number
    }
    err.retryAfter = data.retryAfter
    err.busy = data.busy === true || res.status === 429
    err.status = res.status
    throw err
  }
  return data
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Matches the server's notion of transient free-tier saturation. */
const TRANSIENT_RE = /\b429\b|overload|temporarily|rate limit/i
/** Cap for unflagged busy retries (gateway 502/504 etc.) so a dead upstream ends the run with a clear message. */
const SOFT_BUSY_CAP = 8

/* ============================ micro-chunking ============================ */

/** Below this size a part is no longer split — the request is already tiny. */
const MICRO_FLOOR = 1_500

/** Find a paragraph/sentence boundary near the middle of `text` for clean splits. */
function splitPoint(text: string): number {
  const raw = Math.floor(text.length / 2)
  const lo = Math.max(1, Math.floor(text.length * 0.35))
  const hi = Math.min(text.length - 1, Math.ceil(text.length * 0.65))
  let cut = raw
  const nl2 = text.lastIndexOf('\n\n', raw)
  const nl1 = text.lastIndexOf('\n', raw)
  const sent = text.lastIndexOf('. ', raw)
  if (nl2 >= lo) cut = nl2
  else if (nl1 >= lo) cut = nl1
  else if (sent >= lo) cut = sent + 1
  return Math.min(hi, Math.max(lo, cut))
}

/* ============================ the runner ============================ */

export interface RunHandle {
  aborted: boolean
}

export interface RunHooks {
  onProgress: (p: PipelineProgress) => void
}

export interface RunResult extends Draft {
  aborted: boolean
}

interface RunArgs {
  source: string
  opts: PipelineOptions
  hooks: RunHooks
  handle: RunHandle
  checkpoint?: PipelineCheckpoint // resume state, if any
}

export async function runPipeline(args: RunArgs): Promise<RunResult> {
  const { source, opts, hooks, handle } = args

  let cp: PipelineCheckpoint =
    args.checkpoint ??
    ({
      id: checkpointId(source, opts),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source,
      opts,
      chunks: buildChunks(source, opts.difficulty),
      doneCount: 0,
      cards: [],
      coveredTopics: [],
    } satisfies PipelineCheckpoint)

  const chunks = cp.chunks
  const total = chunks.length
  const totalChars = Math.max(1, chunks.reduce((a, c) => a + c.text.length, 0))

  // Remaining work queue. A previous run may have saved a fine-grained queue
  // (containing split sub-chunks); otherwise derive it from the original chunks.
  const work: PipelineChunk[] =
    cp.queue && cp.queue.length > 0 ? cp.queue : chunks.slice(Math.min(cp.doneCount, total))
  let pos = 0

  const remainingChars = (): number => {
    let s = 0
    for (let k = pos; k < work.length; k++) s += work[k].text.length
    return s
  }
  const partsDone = (): number => total - new Set(work.slice(pos).map((c) => c.i)).size
  const charRates: number[] = [] // chars/sec per finished item — honest ETA across granularities

  const emit = (p: Partial<PipelineProgress> & { stage: PipelineProgress['stage']; label: string }) => {
    const cardsSoFar = cp.cards.length
    const done = Math.max(0, partsDone())
    const queuePct = Math.min(92, Math.round(((totalChars - remainingChars()) / totalChars) * 92))
    const avgRate = charRates.length ? charRates.reduce((a, b) => a + b, 0) / charRates.length : 350
    const etaSec =
      p.retryInSec !== undefined
        ? p.retryInSec
        : Math.round((remainingChars() / Math.max(80, avgRate)) * (opts.verify ? 1.7 : 1) * (opts.deep ? 1.15 : 1))
    hooks.onProgress({
      stage: p.stage,
      label: p.label,
      pct: p.pct ?? queuePct,
      partsDone: p.partsDone ?? done,
      partsTotal: p.partsTotal ?? total,
      cardsSoFar,
      etaSec,
      retryInSec: p.retryInSec,
      // keep the latest cards visible through every stage (no flicker between parts)
      preview: p.preview ?? (cardsSoFar > 0 ? cp.cards.slice(-5).map((c) => ({ question: c.question, answer: c.answer })) : undefined),
    })
  }

  const budgetFor = (i: number): number => {
    if (cp.mapResult) {
      const b = cp.mapResult.budget.find((x) => x.i === i)
      if (b && b.cards > 0) return b.cards
    }
    return Math.max(3, Math.round(opts.count / Math.max(1, total)))
  }

  const sectionFor = (i: number): string => {
    if (cp.mapResult) {
      const s = cp.mapResult.sections.find((sec) => i >= sec.from && i <= sec.to)
      if (s) return s.title
    }
    return chunks[i]?.heading ?? `Part ${i + 1}`
  }

  const budgetForItem = (item: PipelineChunk): number => {
    const full = budgetFor(item.i)
    const orig = chunks[item.i]
    if (!orig || orig.text.length === 0 || item.text.length >= orig.text.length) return full
    // Split sub-chunk: inherit a proportional share of the parent's budget so
    // the final card total stays close to what the user asked for.
    return Math.max(1, Math.round((item.text.length / orig.text.length) * full))
  }

  /**
   * One generation attempt loop for queue[at]. On a busy signal the part is
   * split in half (micro-checkpoint) and the smaller half retried — shorter
   * requests slip into capacity gaps and every success is saved immediately.
   * Only the failing part shrinks; untouched parts keep their cheaper size.
   */
  const callGenerate = async (
    queue: PipelineChunk[],
    at: number,
  ): Promise<{ cards: GeneratedCard[]; meta?: DeckMeta; item: PipelineChunk }> => {
    let item = queue[at]
    let softRetries = 0
    for (;;) {
      if (handle.aborted) return { cards: [], item }
      try {
        const data = await postJSON<{ meta?: DeckMeta; cards?: GeneratedCard[] }>('/api/generate', {
          source: item.text,
          count: budgetForItem(item),
          difficulty: opts.difficulty,
          language: opts.language,
          sectionName: sectionFor(item.i),
          avoidTopics: cp.coveredTopics.slice(-24),
        })
        return { cards: data.cards ?? [], meta: data.meta, item }
      } catch (e) {
        const err = e as Error & { retryAfter?: number; busy?: boolean; status?: number }
        if (handle.aborted) return { cards: [], item }
        // Defense in depth: gateway timeouts (504) and Retry-After-less 429s
        // arrive without the busy flag — recognize them by shape and pause
        // instead of aborting the whole run.
        const softBusy = !err.busy && (TRANSIENT_RE.test(err.message) || err.status === 502 || err.status === 504)
        if (err.busy || softBusy) {
          if (softBusy && ++softRetries > SOFT_BUSY_CAP) {
            throw new Error(
              'The free model tier stayed busy for several minutes. Your progress is saved — wait a moment, then press Generate to resume.',
            )
          }
          const wait = Math.min(Math.max(err.retryAfter ?? 20, 8), 60)
          if (item.text.length > MICRO_FLOOR * 2) {
            const mid = splitPoint(item.text)
            const a: PipelineChunk = { i: item.i, heading: item.heading, text: item.text.slice(0, mid).trim() }
            const b: PipelineChunk = {
              i: item.i,
              heading: item.heading.includes('(cont.') ? item.heading : `${item.heading} (cont.)`,
              text: item.text.slice(mid).trim(),
            }
            queue[at] = a
            queue.splice(at + 1, 0, b)
            item = a
            const pause = Math.min(wait, 15)
            emit({
              stage: 'generate',
              label: 'Free tier is busy — splitting this part in half for better odds…',
              retryInSec: pause,
            })
            await sleep(pause * 1000)
            continue
          }
          emit({ stage: 'generate', label: `Free tier busy — auto-resuming in ${wait}s…`, retryInSec: wait })
          await sleep(wait * 1000)
          continue
        }
        throw err
      }
    }
  }

  const callVerify = async (chunk: PipelineChunk, cards: GeneratedCard[]): Promise<GeneratedCard[]> => {
    if (!opts.verify || cards.length === 0) return cards
    const waits = [0, 8, 15]
    for (const w of waits) {
      if (handle.aborted) return cards
      if (w > 0) {
        emit({ stage: 'verify', label: `Free tier busy — retrying precision check in ${w}s…`, retryInSec: w })
        await sleep(w * 1000)
      }
      try {
        const data = await postJSON<{ cards?: GeneratedCard[] }>('/api/verify', {
          source: chunk.text,
          cards: cards.map((c) => ({ question: c.question, answer: c.answer })),
        })
        if (Array.isArray(data.cards) && data.cards.length > 0) {
          return data.cards.map((c, k) => ({ ...c, section: cards[k]?.section }))
        }
        return cards
      } catch (e) {
        const err = e as Error & { retryAfter?: number; busy?: boolean; status?: number }
        if (err.busy || TRANSIENT_RE.test(err.message) || err.status === 502 || err.status === 504) continue
        return cards // verification is best-effort per chunk
      }
    }
    return cards
  }

  emit({ stage: 'extract', label: 'Preparing sections…', pct: 3 })

  // Pre-flight capacity probe — start smart instead of firing the first request
  // into a saturated pool. /api/status reads the governor's memory (no model
  // call, no tokens). Bounded: after a few tries we start anyway and let the
  // server governor pace us.
  const preflight = async (): Promise<void> => {
    for (let k = 0; k < 4; k++) {
      if (handle.aborted) return
      try {
        const res = await fetch('/api/status', { cache: 'no-store' })
        if (!res.ok) return
        const s = (await res.json()) as {
          queuePending?: number
          governor?: { windowMax: number; windowUsed: number; breakerRemainingSec: number }
        }
        const g = s.governor
        if (!g) return
        if (g.breakerRemainingSec > 0) {
          const w = Math.min(g.breakerRemainingSec + 2, 60)
          emit({ stage: 'extract', label: `Model capacity cooling down — starting in ~${w}s…`, retryInSec: w, pct: 3 })
          await sleep(w * 1000)
          continue
        }
        if ((s.queuePending ?? 0) > 0 || g.windowUsed >= g.windowMax) {
          emit({ stage: 'extract', label: 'Waiting for a free generation slot…', retryInSec: 10, pct: 3 })
          await sleep(10_000)
          continue
        }
        return
      } catch {
        return // probe failed — proceed; the server governor paces us anyway
      }
    }
  }
  await preflight()

  // ---- deep map (optional, once) ----
  if (opts.deep && !cp.mapResult && total >= 2) {
    for (;;) {
      if (handle.aborted) return { aborted: true, meta: cp.firstMeta ?? fallbackMeta(), cards: cp.cards, sourceExcerpt: source.slice(0, 400) }
      try {
        emit({ stage: 'map', label: 'Deep processing — planning sections & card budget…', pct: 6 })
        const data = await postJSON<MapResult>('/api/map', {
          chunks: chunks.map((c) => ({ i: c.i, title: c.heading, excerpt: c.text.slice(0, 220) })),
          total: opts.count,
        })
        cp.mapResult = { sections: data.sections ?? [], budget: data.budget ?? [] }
        saveCheckpoint(cp)
        break
      } catch (e) {
        const err = e as Error & { retryAfter?: number; busy?: boolean }
        if (handle.aborted) return { aborted: true, meta: cp.firstMeta ?? fallbackMeta(), cards: cp.cards, sourceExcerpt: source.slice(0, 400) }
        if (err.busy) {
          const wait = Math.min(Math.max(err.retryAfter ?? 20, 8), 60)
          emit({ stage: 'map', label: `Free tier busy — auto-resuming in ${wait}s…`, retryInSec: wait })
          await sleep(wait * 1000)
          continue
        }
        // map is optional — degrade gracefully
        emit({ stage: 'map', label: 'Deep planning skipped (busy) — continuing with even budget…' })
        break
      }
    }
  }

  // ---- generation loop (every part, however small, is a checkpoint) ----
  while (pos < work.length) {
    if (handle.aborted) break
    const planned = work[pos]
    const partNo = Math.min(partsDone() + 1, total)
    emit({ stage: 'generate', label: `Part ${partNo}/${total} — ${planned.heading} · generating…` })
    const t0 = Date.now()

    const { cards: genCards, meta, item } = await callGenerate(work, pos)
    if (handle.aborted) break
    if (meta && !cp.firstMeta) {
      cp.firstMeta = meta
      if (cp.mapResult && cp.mapResult.sections.length > 0) {
        cp.firstMeta.deckTitle = `${cp.firstMeta.deckTitle}`.slice(0, 120)
      }
    }

    let chunkCards: GeneratedCard[] = genCards.map((c) => ({ ...c, section: sectionFor(item.i) }))

    if (opts.verify && chunkCards.length > 0) {
      emit({ stage: 'verify', label: `Part ${partNo}/${total} — precision check…` })
      chunkCards = await callVerify(item, chunkCards)
    }

    cp.cards.push(...chunkCards)
    for (const c of chunkCards) {
      const topic = c.question.split(/\s+/).slice(0, 9).join(' ')
      if (topic && !cp.coveredTopics.includes(topic)) cp.coveredTopics.push(topic)
    }

    pos++
    charRates.push(Math.max(30, item.text.length / Math.max(1, (Date.now() - t0) / 1000)))
    cp.doneCount = Math.max(0, partsDone())
    cp.queue = work.slice(pos)
    saveCheckpoint(cp)
    emit({
      stage: 'generate',
      label: `Part ${Math.min(partsDone(), total)}/${total} done — ${cp.cards.length} cards so far`,
      preview: cp.cards.slice(-5).map((c) => ({ question: c.question, answer: c.answer })),
    })
  }

  if (handle.aborted) {
    saveCheckpoint(cp)
    return {
      aborted: true,
      meta: cp.firstMeta ?? fallbackMeta(),
      cards: cp.cards,
      sourceExcerpt: source.slice(0, 400),
      sections: cp.mapResult?.sections.map((s) => s.title),
    }
  }

  // ---- dedupe (pure code) ----
  emit({ stage: 'finalize', label: 'Removing duplicates & organizing sections…', pct: 95 })
  const deduped = dedupeCards(cp.cards)
  let cards = deduped.cards
  cp.cards = cards
  saveCheckpoint(cp)

  // ---- deep link: integration cards across boundaries (optional) ----
  if (opts.deep && total >= 2 && cards.length > 0) {
    const maxBoundaries = 6
    const step = Math.max(1, Math.floor((total - 1) / maxBoundaries))
    const boundaries: Array<{ a: PipelineChunk; b: PipelineChunk }> = []
    for (let i = 0; i < total - 1 && boundaries.length < maxBoundaries; i += step) {
      boundaries.push({ a: chunks[i], b: chunks[i + 1] })
    }
    for (let k = 0; k < boundaries.length; k += 4) {
      if (handle.aborted) break
      const batch = boundaries.slice(k, k + 4)
      emit({ stage: 'link', label: `Deep processing — linking sections (batch ${Math.floor(k / 4) + 1})…`, pct: 96 })
      try {
        const data = await postJSON<{ cards?: GeneratedCard[] }>('/api/link', {
          boundaries: batch.map((b) => ({
            aTitle: b.a.heading,
            aTail: b.a.text.slice(-1_300),
            bTitle: b.b.heading,
            bHead: b.b.text.slice(0, 1_300),
          })),
        })
        const linked = (data.cards ?? []).map((c) => ({ ...c, section: c.section || 'Integration' }))
        if (linked.length > 0) {
          cards.push(...dedupeCards(linked).cards)
        }
      } catch {
        // linking is optional — skip silently on failure
      }
    }
  }

  clearCheckpoint()

  const sections =
    cp.mapResult && cp.mapResult.sections.length > 0
      ? cp.mapResult.sections.map((s) => s.title)
      : Array.from(new Set(chunks.map((c) => c.heading)))

  emit({ stage: 'finalize', label: `Done — ${cards.length} cards ready`, pct: 100 })

  return {
    aborted: false,
    meta: cp.firstMeta ?? fallbackMeta(),
    cards,
    sourceExcerpt: source.slice(0, 400),
    sections,
    stats: { duplicatesMerged: deduped.merged },
  }
}

function fallbackMeta(): DeckMeta {
  return { deckTitle: 'Untitled deck', subject: 'General', system: '-', topic: '-', tags: [] }
}

export { uid }
