import { NextResponse } from 'next/server'
import { queueSnapshot } from '@/lib/server/llm'

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'ai-flashcards',
    model: process.env.ZAI_MODEL || 'glm-4.7-flash',
    backend: process.env.ZAI_API_KEY ? 'env-key' : 'sandbox-sdk',
    queuePending: queueSnapshot(),
  })
}
