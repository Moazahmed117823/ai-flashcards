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
  sectionName?: string
  avoidTopics?: string[]
}): Msg[] {
  const langLine =
    opts.language && opts.language !== 'auto'
      ? `Write the cards in: ${opts.language}.`
      : 'Write the cards in the same language as the source material.'

  const extra: string[] = []
  if (opts.sectionName && opts.sectionName !== '-') {
    extra.push(`This text is the section "${opts.sectionName}" of a larger document — scope every card to THIS section's content.`)
  }
  if (opts.avoidTopics && opts.avoidTopics.length > 0) {
    extra.push(
      `Earlier sections already produced cards about these topics — do NOT create near-duplicates of them (new angles on details unique to this section are fine):\n- ${opts.avoidTopics.slice(0, 30).join('\n- ')}`,
    )
  }
  const extraBlock = extra.length > 0 ? `\n${extra.join('\n')}\n` : ''

  const user = `SOURCE MATERIAL:
"""
${opts.source}
"""
${extraBlock}
Create exactly ${opts.count} flashcards (${opts.difficulty} difficulty). ${langLine}
Remember: reply with ONLY the JSON object following the required schema.`

  return [
    { role: 'system', content: GEN_SYSTEM },
    { role: 'user', content: user },
  ]
}

/* ---------- deep-processing: map & link ---------- */

const MAP_SYSTEM = `You are a study-curriculum planner. You receive the outline of sections of a long document and a target total number of flashcards. Produce a plan:
1. "sections": group consecutive chunks into meaningful study sections (each {"title": string, "from": chunkIndex, "to": chunkIndex}, inclusive, non-overlapping, covering every chunk).
2. "budget": how many cards each chunk should produce (each {"i": chunkIndex, "cards": integer}), so the totals roughly reach the target. Chunks with denser/more exam-relevant content get more.
Reply with ONE valid JSON object and NOTHING else:
{"sections": [{"title": string, "from": number, "to": number}], "budget": [{"i": number, "cards": number}]}`

export function buildMapMessages(
  chunks: Array<{ i: number; title: string; excerpt: string }>,
  total: number,
): Msg[] {
  const listing = chunks
    .map((c) => `#${c.i} [${c.title}]\n${c.excerpt.slice(0, 220)}`)
    .join('\n\n')
  const user = `Document outline (${chunks.length} parts), target total: ${total} cards.

${listing.slice(0, 24_000)}

Produce the plan as the required JSON object.`
  return [
    { role: 'system', content: MAP_SYSTEM },
    { role: 'user', content: user },
  ]
}

const LINK_SYSTEM = `You write INTEGRATION flashcards that connect concepts ACROSS two adjacent parts of the same document. You get the end of Part A and the start of Part B.
Rules:
- Write at most 2 cards per boundary; only when a genuine, exam-worthy connection exists (cause/effect, comparison, sequence, mechanism linking both parts).
- Each card must be grounded ONLY in the provided text and must reference ideas from BOTH parts.
- If no meaningful connection exists, return an empty cards array.
Reply with ONE valid JSON object and NOTHING else:
{"cards": [{"question": string, "answer": string, "section": string}]}
"section" should name the combined topic, e.g. "Cardiac cycle ↔ Conduction disorders".`

export function buildLinkMessages(
  boundaries: Array<{ aTitle: string; aTail: string; bTitle: string; bHead: string }>,
): Msg[] {
  const blocks = boundaries
    .map(
      (b, k) =>
        `BOUNDARY ${k + 1}:
END OF "${b.aTitle}":
"""${b.aTail.slice(-1_300)}"""
START OF "${b.bTitle}":
"""${b.bHead.slice(0, 1_300)}"""`,
    )
    .join('\n\n')
  const user = `${blocks.slice(0, 22_000)}

Write integration cards for each boundary where warranted. Reply with ONLY the JSON object.`
  return [
    { role: 'system', content: LINK_SYSTEM },
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
