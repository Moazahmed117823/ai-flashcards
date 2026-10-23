import { openDB, type IDBPDatabase } from 'idb'
import type { Deck } from './types'

const DB_NAME = 'ai-flashcards'
const DB_VERSION = 1
const STORE = 'decks'

let dbp: Promise<IDBPDatabase> | null = null

function db(): Promise<IDBPDatabase> {
  if (!dbp) {
    dbp = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE)) {
          d.createObjectStore(STORE, { keyPath: 'id' })
        }
      },
    })
  }
  return dbp
}

function available(): boolean {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined'
}

export async function getAllDecks(): Promise<Deck[]> {
  if (!available()) return []
  try {
    const all = (await (await db()).getAll(STORE)) as Deck[]
    return all.sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

export async function getDeck(id: string): Promise<Deck | undefined> {
  if (!available()) return undefined
  return (await (await db()).get(STORE, id)) as Deck | undefined
}

export async function saveDeck(deck: Deck): Promise<void> {
  const d = await db()
  await d.put(STORE, { ...deck, updatedAt: Date.now() })
}

export async function deleteDeck(id: string): Promise<void> {
  const d = await db()
  await d.delete(STORE, id)
}

export async function clearAllDecks(): Promise<void> {
  const d = await db()
  await d.clear(STORE)
}

export function exportAll(decks: Deck[]): string {
  return JSON.stringify({ app: 'ai-flashcards', version: 1, exportedAt: new Date().toISOString(), decks }, null, 2)
}

export interface ImportResult {
  added: number
  updated: number
}

export async function importDecks(json: string): Promise<ImportResult> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('File is not valid JSON.')
  }
  const decksRaw =
    parsed && typeof parsed === 'object' && 'decks' in parsed
      ? (parsed as { decks: unknown }).decks
      : parsed
  if (!Array.isArray(decksRaw)) throw new Error('JSON does not contain a decks array.')

  const d = await db()
  let added = 0
  let updated = 0
  for (const raw of decksRaw) {
    const deck = raw as Partial<Deck>
    if (!deck || typeof deck !== 'object' || !Array.isArray(deck.cards) || typeof deck.title !== 'string') continue
    const existing = (await d.get(STORE, deck.id)) as Deck | undefined
    if (existing && (existing.updatedAt ?? 0) >= (deck.updatedAt ?? 0)) continue
    await d.put(STORE, deck)
    if (existing) updated++
    else added++
  }
  return { added, updated }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    const e = await navigator.storage.estimate()
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 }
  }
  return null
}

export function downloadFile(filename: string, content: string, mime = 'application/json'): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/** Anki-friendly TSV: question <TAB> answer, plus tags column. */
export function deckToTsv(deck: Deck): string {
  const tags = ['#' + [deck.subject, deck.system, deck.topic, ...deck.tags].filter(Boolean).join(' #')]
  const lines = deck.cards.map((c) => `${c.question.replace(/\t|\n/g, ' ')}\t${c.answer.replace(/\t|\n/g, ' ')}\t${tags}`)
  return lines.join('\n')
}

export const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'deck'
