import { NextRequest, NextResponse } from 'next/server'
import { buildLinkMessages } from '@/lib/prompt'
import { chat, enqueue, extractJson, QueueFullError, UpstreamError } from '@/lib/server/llm'
import { BusyError } from '@/lib/server/governor'
import type { GeneratedCard } from '@/lib/types'

export const maxDuration = 60

interface Body {
  boundaries?: Array<{ aTitle: string; aTail: string; bTitle: string; bHead: string }>
}

/** Deep processing (optional): integration cards that connect adjacent sections. */
export async function POST(req: NextRequest) {
  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const boundaries = (body.boundaries ?? [])
    .filter((b) => b && typeof b.aTail === 'string' && typeof b.bHead === 'string')
    .slice(0, 4)
  if (boundaries.length === 0) {
    return NextResponse.json({ error: 'No boundaries provided.' }, { status: 400 })
  }

  try {
    const cards = await enqueue(async (): Promise<GeneratedCard[]> => {
      const raw = await chat(buildLinkMessages(boundaries))
      const parsed = extractJson(raw)
      const arr = Array.isArray(parsed.cards) ? (parsed.cards as Array<Record<string, unknown>>) : []
      return arr
        .map((c) => ({
          question: String(c?.question ?? '').trim(),
          answer: String(c?.answer ?? '').trim(),
          section: String(c?.section ?? 'Integration').slice(0, 80),
        }))
        .filter((c) => c.question && c.answer)
        .slice(0, 8)
    })

    return NextResponse.json({ ok: true, cards })
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
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Linking failed.' }, { status: 502 })
  }
}
