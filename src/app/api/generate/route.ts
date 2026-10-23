import { NextRequest, NextResponse } from 'next/server'
import { buildGenMessages } from '@/lib/prompt'
import { chat, enqueue, extractJson, isTransientMessage, QueueFullError, UpstreamError } from '@/lib/server/llm'
import { BusyError } from '@/lib/server/governor'

export const maxDuration = 60

interface Body {
  source?: string
  count?: number
  difficulty?: 'easy' | 'medium' | 'hard' | 'mixed'
  language?: string
  sectionName?: string
  avoidTopics?: string[]
}

export async function POST(req: NextRequest) {
  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const source = (body.source ?? '').trim()
  const count = Math.min(Math.max(Number(body.count) || 12, 3), 40)
  const difficulty = body.difficulty ?? 'mixed'
  const language = body.language || 'auto'
  const userKey = req.headers.get('x-user-key')?.trim() || undefined

  if (source.length < 40) {
    return NextResponse.json({ error: 'Source text is too short (minimum ~40 characters).' }, { status: 400 })
  }
  if (source.length > 200_000) {
    return NextResponse.json({ error: 'Source text is too long — split it into smaller sections.' }, { status: 400 })
  }

  try {
    const result = await enqueue(async () => {
      const messages = buildGenMessages({
        source,
        count,
        difficulty,
        language,
        sectionName: body.sectionName,
        avoidTopics: body.avoidTopics,
      })

      let raw = await chat(messages, userKey)
      let parsed: Record<string, unknown>
      try {
        parsed = extractJson(raw)
      } catch {
        raw = await chat([
          ...messages,
          { role: 'assistant', content: raw.slice(0, 800) },
          { role: 'user', content: 'That was not valid JSON. Reply again with ONLY the JSON object, no other text.' },
        ])
        parsed = extractJson(raw)
      }

      const cardsRaw = Array.isArray(parsed.cards) ? (parsed.cards as Array<Record<string, unknown>>) : []
      const cards = cardsRaw
        .map((c) => ({
          question: String(c?.question ?? '').trim(),
          answer: String(c?.answer ?? '').trim(),
        }))
        .filter((c) => c.question.length > 0 && c.answer.length > 0)

      if (cards.length === 0) throw new Error('The model returned no usable cards. Try regenerating.')

      const tags = Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t)).slice(0, 8) : []
      const meta = {
        deckTitle: String(parsed.deckTitle ?? 'Untitled deck').slice(0, 120),
        subject: String(parsed.subject ?? 'General').slice(0, 60),
        system: String(parsed.system ?? '-').slice(0, 60),
        topic: String(parsed.topic ?? '-').slice(0, 80),
        tags,
      }
      return { meta, cards }
    })

    return NextResponse.json({ ok: true, ...result, model: process.env.ZAI_MODEL || 'glm-4.7-flash' })
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
    // Z.ai 429s often arrive WITHOUT a Retry-After header — they must still be
    // treated as "busy" so the client pauses and resumes instead of aborting.
    if (e instanceof Error && isTransientMessage(e.message)) {
      return NextResponse.json({ error: e.message, retryAfter: 20, busy: true }, { status: 429 })
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Generation failed.' }, { status: 502 })
  }
}
