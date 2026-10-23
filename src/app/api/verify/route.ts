import { NextRequest, NextResponse } from 'next/server'
import { buildVerifyMessages } from '@/lib/prompt'
import { chat, enqueue, extractJson, isTransientMessage, QueueFullError, UpstreamError } from '@/lib/server/llm'
import { BusyError } from '@/lib/server/governor'

export const maxDuration = 60

interface Body {
  source?: string
  cards?: Array<{ question?: string; answer?: string }>
}

export interface VerifiedCard {
  question: string
  answer: string
  verdict: 'ok' | 'fixed' | 'removed'
  note: string
}

export async function POST(req: NextRequest) {
  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const source = (body.source ?? '').trim()
  const inputCards = (body.cards ?? [])
    .map((c) => ({ question: String(c?.question ?? '').trim(), answer: String(c?.answer ?? '').trim() }))
    .filter((c) => c.question && c.answer)
  const userKey = req.headers.get('x-user-key')?.trim() || undefined

  if (source.length < 40) {
    return NextResponse.json({ error: 'Source text is too short to verify against.' }, { status: 400 })
  }
  if (inputCards.length === 0) {
    return NextResponse.json({ error: 'No cards to verify.' }, { status: 400 })
  }
  if (inputCards.length > 60) {
    return NextResponse.json({ error: 'Too many cards for one verification pass (max 60).' }, { status: 400 })
  }

  try {
    const verified = await enqueue(async (): Promise<VerifiedCard[]> => {
      const messages = buildVerifyMessages(source, inputCards)
      const raw = await chat(messages, userKey)
      const parsed = extractJson(raw)
      const arr = Array.isArray(parsed.cards) ? (parsed.cards as Array<Record<string, unknown>>) : []
      return arr.map((c) => {
        const verdict = c?.verdict === 'fixed' || c?.verdict === 'removed' ? (c.verdict as 'fixed' | 'removed') : 'ok'
        return {
          question: String(c?.question ?? '').trim(),
          answer: String(c?.answer ?? '').trim(),
          verdict,
          note: String(c?.note ?? '').slice(0, 300),
        }
      })
    })

    return NextResponse.json({ ok: true, cards: verified })
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
    // Retry-After-less upstream 429s must also surface as busy (see generate route).
    if (e instanceof Error && isTransientMessage(e.message)) {
      return NextResponse.json({ error: e.message, retryAfter: 20, busy: true }, { status: 429 })
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Verification failed.' }, { status: 502 })
  }
}
