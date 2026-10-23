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
    const err = new Error(data.error || `Request failed (${res.status})`) as Error & { retryAfter?: number; busy?: boolean }
    err.retryAfter = data.retryAfter
    err.busy = data.busy === true || res.status === 429
    throw err
  }
  return data
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
  const chunkDurationsSec: number[] = []

  const emit = (p: Partial<PipelineProgress> & { stage: PipelineProgress['stage']; label: string }) => {
    const cardsSoFar = cp.cards.length
    const remaining = Math.max(0, total - cp.doneCount)
    const avg = chunkDurationsSec.length ? chunkDurationsSec.reduce((a, b) => a + b, 0) / chunkDurationsSec.length : 22
    const etaSec =
      p.retryInSec !== undefined
        ? p.retryInSec
        : Math.round(remaining * avg * (opts.verify ? 1.7 : 1) * (opts.deep ? 1.15 : 1))
    hooks.onProgress({
      stage: p.stage,
      label: p.label,
      pct: p.pct ?? Math.min(98, Math.round((cp.doneCount / Math.max(1, total)) * 88)),
      partsDone: p.partsDone ?? cp.doneCount,
      partsTotal: p.partsTotal ?? total,
      cardsSoFar,
      etaSec,
      retryInSec: p.retryInSec,
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

  const callGenerate = async (chunk: PipelineChunk): Promise<{ cards: GeneratedCard[]; meta?: DeckMeta }> => {
    for (;;) {
      if (handle.aborted) return { cards: [] }
      try {
        const data = await postJSON<{ meta?: DeckMeta; cards?: GeneratedCard[] }>('/api/generate', {
          source: chunk.text,
          count: budgetFor(chunk.i),
          difficulty: opts.difficulty,
          language: opts.language,
          sectionName: sectionFor(chunk.i),
          avoidTopics: cp.coveredTopics.slice(-24),
        })
        return { cards: data.cards ?? [], meta: data.meta }
      } catch (e) {
        const err = e as Error & { retryAfter?: number; busy?: boolean }
        if (handle.aborted) return { cards: [] }
        if (err.busy) {
          const wait = Math.min(Math.max(err.retryAfter ?? 20, 8), 60)
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
        const err = e as Error & { retryAfter?: number; busy?: boolean }
        if (err.busy) continue
        return cards // verification is best-effort per chunk
      }
    }
    return cards
  }

  emit({ stage: 'extract', label: 'Preparing sections…', pct: 3 })

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

  // ---- generation loop (each chunk = a checkpoint) ----
  for (let i = cp.doneCount; i < total; i++) {
    if (handle.aborted) break
    const chunk = chunks[i]
    const t0 = Date.now()
    emit({ stage: 'generate', label: `Part ${i + 1}/${total} — ${chunk.heading} · generating…` })

    const { cards: genCards, meta } = await callGenerate(chunk)
    if (handle.aborted) break
    if (meta && !cp.firstMeta) {
      cp.firstMeta = meta
      if (cp.mapResult && cp.mapResult.sections.length > 0) {
        cp.firstMeta.deckTitle = `${cp.firstMeta.deckTitle}`.slice(0, 120)
      }
    }

    let chunkCards: GeneratedCard[] = genCards.map((c) => ({ ...c, section: sectionFor(i) }))

    if (opts.verify && chunkCards.length > 0) {
      emit({ stage: 'verify', label: `Part ${i + 1}/${total} — precision check…` })
      chunkCards = await callVerify(chunk, chunkCards)
    }

    cp.cards.push(...chunkCards)
    for (const c of chunkCards) {
      const topic = c.question.split(/\s+/).slice(0, 9).join(' ')
      if (topic && !cp.coveredTopics.includes(topic)) cp.coveredTopics.push(topic)
    }
    cp.doneCount = i + 1
    chunkDurationsSec.push((Date.now() - t0) / 1000)
    saveCheckpoint(cp)
    emit({ stage: 'generate', label: `Part ${i + 1}/${total} done — ${cp.cards.length} cards so far` })
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
