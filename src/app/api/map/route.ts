import { NextRequest, NextResponse } from 'next/server'
import { buildMapMessages } from '@/lib/prompt'
import { chat, enqueue, extractJson, QueueFullError, UpstreamError } from '@/lib/server/llm'
import { BusyError } from '@/lib/server/governor'
import type { MapResult } from '@/lib/types'

export const maxDuration = 60

interface Body {
  chunks?: Array<{ i: number; title: string; excerpt: string }>
  total?: number
}

/** Deep processing (optional): one planning call — sections + per-chunk card budget. */
export async function POST(req: NextRequest) {
  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const chunks = (body.chunks ?? []).filter((c) => Number.isInteger(c.i) && typeof c.title === 'string')
  const total = Math.min(Math.max(Number(body.total) || 12, 3), 200)
  if (chunks.length < 2 || chunks.length > 60) {
    return NextResponse.json({ error: 'Map expects between 2 and 60 chunks.' }, { status: 400 })
  }

  try {
    const map = await enqueue(async (): Promise<MapResult> => {
      const raw = await chat(buildMapMessages(chunks, total))
      const parsed = extractJson(raw)
      const rawSections = Array.isArray(parsed.sections) ? (parsed.sections as Array<Record<string, unknown>>) : []
      const rawBudget = Array.isArray(parsed.budget) ? (parsed.budget as Array<Record<string, unknown>>) : []

      const sections = rawSections
        .map((s) => ({
          title: String(s?.title ?? 'Section').slice(0, 80),
          from: Math.max(0, Number(s?.from) || 0),
          to: Math.max(0, Number(s?.to) || 0),
        }))
        .filter((s) => s.to >= s.from && s.to < chunks.length)
      const budget = rawBudget
        .map((b) => ({ i: Math.max(0, Number(b?.i) || 0), cards: Math.min(Math.max(Number(b?.cards) || 0, 0), 20) }))
        .filter((b) => b.i < chunks.length)

      // Fallbacks: even budget, single section if the model misbehaved
      const even = Math.max(3, Math.round(total / chunks.length))
      const safeBudget =
        budget.length >= Math.ceil(chunks.length / 2)
          ? budget
          : chunks.map((c) => ({ i: c.i, cards: even }))
      const safeSections =
        sections.length > 0
          ? sections
          : [{ title: 'Full document', from: 0, to: chunks.length - 1 }]

      return { sections: safeSections, budget: safeBudget }
    })

    return NextResponse.json({ ok: true, ...map })
  } catch (e) {
    if (e instanceof QueueFullError) {
      return NextResponse.json({ error: e.message, retryAfter: 30 }, { status: 429 })
    }
    if (e instanceof BusyError) {
      return NextResponse.json({ error: e.message, retryAfter: e.retryAfterSec, busy: true }, { status: 429 })
    }
    if (e instanceof UpstreamError && e.retryAfterSec) {
      return NextResponse.json({ error: e.message, retryAfter: e.retryAfterSec, busy: true }, { status: 429 })
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Mapping failed.' }, { status: 502 })
  }
}
