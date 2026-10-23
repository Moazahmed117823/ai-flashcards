export interface CardProgress {
  reps: number
  ease: number
  interval: number // days
  due: number // epoch ms
  lapses: number
  last?: number // epoch ms of last review
}

export interface Flashcard {
  id: string
  question: string
  answer: string
  progress: CardProgress
}

export interface Deck {
  id: string
  title: string
  subject: string
  system: string
  topic: string
  tags: string[]
  sourceExcerpt?: string
  createdAt: number
  updatedAt: number
  cards: Flashcard[]
}

export interface DeckMeta {
  deckTitle: string
  subject: string
  system: string
  topic: string
  tags: string[]
}

export type Difficulty = 'easy' | 'medium' | 'hard' | 'mixed'

export interface GenOptions {
  count: number
  difficulty: Difficulty
  language: string
}

export interface GeneratedCard {
  question: string
  answer: string
  verdict?: 'ok' | 'fixed' | 'removed'
  note?: string
}

export interface Draft {
  meta: DeckMeta
  cards: GeneratedCard[]
  sourceExcerpt: string
}

export const uid = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export const newCard = (question: string, answer: string): Flashcard => ({
  id: uid(),
  question,
  answer,
  progress: { reps: 0, ease: 2.5, interval: 0, due: 0, lapses: 0 },
})
