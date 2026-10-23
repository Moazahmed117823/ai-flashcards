import type { Difficulty, GeneratedCard } from './types'

export type Msg = { role: 'system' | 'user' | 'assistant'; content: string }

const GEN_SYSTEM = `You are an expert exam-prep content author who converts study material into precise, high-quality question/answer flashcards. You are especially careful with scientific and medical content.

STRICT RULES:
1. GROUNDING: Every flashcard must be derived ONLY from facts explicitly present in the SOURCE MATERIAL provided by the user. Never add outside facts, never invent numbers, doses, cutoffs or names. If the source is thin, produce fewer, simpler cards.
2. ONE CONCEPT PER CARD: each card tests exactly one idea. Questions must be self-contained and unambiguous (the reader sees only the question).
3. PRECISION: answers are concise but complete. If the source contains exact values (thresholds, doses, durations, criteria), include them verbatim.
4. DIFFICULTY:
   - easy: direct recall / definitions
   - medium: mechanisms, comparisons, applications
   - hard: integration, differentials, edge cases, multi-step reasoning grounded in the source
   - mixed: a sensible blend
5. LANGUAGE: write cards in the same language as the source material, unless the user requests a specific output language.
6. METADATA: infer "subject" (broad field, e.g. Pharmacology / Biochemistry / History), "system" (organ system or subfield, use "-" if not applicable), "topic" (specific lecture/chapter theme), and up to 6 short keyword "tags". If the source is not medical, infer equivalent fields.
7. OUTPUT: reply with ONE valid JSON object and NOTHING else (no markdown fences, no commentary), exactly in this schema:
{"deckTitle": string, "subject": string, "system": string, "topic": string, "tags": string[], "cards": [{"question": string, "answer": string}]}`

export function buildGenMessages(opts: {
  source: string
  count: number
  difficulty: Difficulty
  language: string
}): Msg[] {
  const langLine =
    opts.language && opts.language !== 'auto'
      ? `Write the cards in: ${opts.language}.`
      : 'Write the cards in the same language as the source material.'

  const user = `SOURCE MATERIAL:
"""
${opts.source}
"""

Create exactly ${opts.count} flashcards (${opts.difficulty} difficulty). ${langLine}
Remember: reply with ONLY the JSON object following the required schema.`

  return [
    { role: 'system', content: GEN_SYSTEM },
    { role: 'user', content: user },
  ]
}

const VERIFY_SYSTEM = `You are a meticulous fact-checker for exam flashcards. You will receive SOURCE MATERIAL and a JSON array of flashcards. Verify every card strictly against the source:
- "ok": the answer is fully supported by the source, unchanged.
- "fixed": a correctable flaw (wrong number, wrong term, missing qualifier). Return the corrected answer, grounded ONLY in the source.
- "removed": the answer is unsupported by, or contradicts, the source (e.g. the model added outside facts). Keep the question and answer fields (copy them through) and explain in "note".
Preserve the original wording whenever a card is fine. Reply with ONE valid JSON object and NOTHING else:
{"cards": [{"question": string, "answer": string, "verdict": "ok" | "fixed" | "removed", "note": string}]}`

export function buildVerifyMessages(source: string, cards: GeneratedCard[]): Msg[] {
  const user = `SOURCE MATERIAL:
"""
${source}
"""

CARDS TO VERIFY:
${JSON.stringify(cards, null, 1)}

Verify each card. Reply with ONLY the JSON object following the required schema.`
  return [
    { role: 'system', content: VERIFY_SYSTEM },
    { role: 'user', content: user },
  ]
}
