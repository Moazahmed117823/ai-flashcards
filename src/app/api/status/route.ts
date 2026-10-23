import { NextResponse } from 'next/server'
import { governor, queueSnapshot } from '@/lib/server/llm'

export const dynamic = 'force-dynamic'

/** Lightweight capacity probe so the UI can show "busy / waiting" states. */
export async function GET() {
  return NextResponse.json({
    ok: true,
    queuePending: queueSnapshot(),
    governor: governor.snapshot(),
  })
}
