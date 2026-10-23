import { NextRequest, NextResponse } from 'next/server'
import { chat, isTransientMessage } from '@/lib/server/llm'
import { BusyError } from '@/lib/server/governor'

export const maxDuration = 30

/**
 * Cheap check for a visitor's personal Z.ai key: one tiny model call billed
 * to THAT key. The key is used for this request only and is never stored.
 */
export async function POST(req: NextRequest) {
  let body: { key?: string }
  try {
    body = (await req.json()) as { key?: string }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const key = (body.key ?? '').trim()
  if (key.length < 20) {
    return NextResponse.json({ error: 'That does not look like a Z.ai API key.' }, { status: 400 })
  }

  try {
    await chat([{ role: 'user', content: 'Reply with the single word: ok' }], key)
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof BusyError) {
      return NextResponse.json({ error: e.message, busy: true, retryAfter: e.retryAfterSec }, { status: 429 })
    }
    const msg = e instanceof Error ? e.message : 'Key check failed.'
    // Upstream auth failure means the key itself was rejected.
    if (/error 40[13]/.test(msg)) {
      return NextResponse.json({ error: 'Z.ai rejected this key — double-check it (401/403).' }, { status: 400 })
    }
    if (isTransientMessage(msg)) {
      return NextResponse.json({ error: 'Free tier is busy right now — the key could not be tested, but it may still work. Try again in a minute.', busy: true, retryAfter: 20 }, { status: 429 })
    }
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
