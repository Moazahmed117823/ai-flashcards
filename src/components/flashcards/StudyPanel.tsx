'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Eye, GraduationCap, List, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { CardProgress, Deck, Flashcard } from '@/lib/types'
import { newCard, uid } from '@/lib/types'
import { deckStats, intervalLabel, isNew, isDue, rateCard, type Rating } from '@/lib/srs'
import { saveDeck } from '@/lib/storage'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

interface Props {
  decks: Deck[]
  studyId: string | null
  startInBrowse?: boolean
  onExit: () => void
  onDeckChanged: () => void
}

interface SessionStat {
  again: number
  hard: number
  good: number
  easy: number
}

const RATINGS: Array<{ q: Rating; label: string; key: string; cls: string }> = [
  { q: 0, label: 'Again', key: '1', cls: 'bg-red-600 hover:bg-red-600/90 text-white' },
  { q: 1, label: 'Hard', key: '2', cls: 'bg-amber-600 hover:bg-amber-600/90 text-white' },
  { q: 2, label: 'Good', key: '3', cls: 'bg-emerald-600 hover:bg-emerald-600/90 text-white' },
  { q: 3, label: 'Easy', key: '4', cls: 'bg-teal-600 hover:bg-teal-600/90 text-white' },
]

export function StudyPanel({ decks, studyId, startInBrowse, onExit, onDeckChanged }: Props) {
  const [deckId, setDeckId] = useState<string>(studyId ?? decks[0]?.id ?? '')
  const [mode, setMode] = useState<'idle' | 'session' | 'browse'>(startInBrowse ? 'browse' : 'idle')
  const [queue, setQueue] = useState<string[]>([])
  const [pos, setPos] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [stats, setStats] = useState<SessionStat>({ again: 0, hard: 0, good: 0, easy: 0 })
  const deck = useMemo(() => decks.find((d) => d.id === deckId), [decks, deckId])

  const deckRef = useRef<Deck | undefined>(deck)
  useEffect(() => {
    deckRef.current = deck
  }, [deck])

  const startSession = useCallback(
    (all = false) => {
      if (!deck) return
      const now = Date.now()
      const dueCards = deck.cards.filter((c) => !isNew(c.progress) && isDue(c.progress, now))
      const newCards = deck.cards.filter((c) => isNew(c.progress))
      const rest = deck.cards.filter((c) => !isNew(c.progress) && !isDue(c.progress, now))
      const ordered = [...dueCards, ...newCards, ...(all ? rest : [])]
      if (ordered.length === 0) {
        toast.success('Nothing due in this deck — everything is scheduled for later.')
        return
      }
      setQueue(ordered.map((c) => c.id))
      setPos(0)
      setFlipped(false)
      setStats({ again: 0, hard: 0, good: 0, easy: 0 })
      setMode('session')
    },
    [deck],
  )

  const current = useMemo(() => deck?.cards.find((c) => c.id === queue[pos]), [deck, queue, pos])

  const applyRating = useCallback(
    (q: Rating) => {
      const d = deckRef.current
      const card = d?.cards.find((c) => c.id === queue[pos])
      if (!d || !card) return
      const updated: Deck = {
        ...d,
        cards: d.cards.map((c) => (c.id === card.id ? { ...c, progress: rateCard(c.progress, q) } : c)),
        updatedAt: Date.now(),
      }
      deckRef.current = updated
      void saveDeck(updated).catch(() => toast.error('Could not save progress to this browser.'))
      setStats((s) => ({ ...s, [['again', 'hard', 'good', 'easy'][q] as keyof SessionStat]: s[['again', 'hard', 'good', 'easy'][q] as keyof SessionStat] + 1 }))
      setFlipped(false)
      setPos((p) => p + 1)
    },
    [queue, pos],
  )

  // keyboard shortcuts
  useEffect(() => {
    if (mode !== 'session') return
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return
      if (e.code === 'Space' || e.key === 'Enter') {
        e.preventDefault()
        if (!flipped) setFlipped(true)
        else applyRating(2)
      } else if (flipped && ['1', '2', '3', '4'].includes(e.key)) {
        applyRating((Number(e.key) - 1) as Rating)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [mode, flipped, applyRating])

  const finished = mode === 'session' && pos >= queue.length

  async function saveEditedCard(cardId: string, question: string, answer: string) {
    if (!deck) return
    const updated: Deck = {
      ...deck,
      cards: deck.cards.map((c) => (c.id === cardId ? { ...c, question, answer } : c)),
      updatedAt: Date.now(),
    }
    deckRef.current = updated
    await saveDeck(updated)
    onDeckChanged()
    toast.success('Card updated.')
  }

  async function deleteCard(cardId: string) {
    if (!deck) return
    const updated: Deck = { ...deck, cards: deck.cards.filter((c) => c.id !== cardId), updatedAt: Date.now() }
    deckRef.current = updated
    await saveDeck(updated)
    onDeckChanged()
    toast.success('Card deleted.')
  }

  async function addCard(question: string, answer: string) {
    if (!deck) return
    const updated: Deck = { ...deck, cards: [...deck.cards, newCard(question, answer)], updatedAt: Date.now() }
    deckRef.current = updated
    await saveDeck(updated)
    onDeckChanged()
    toast.success('Card added.')
  }

  if (decks.length === 0) {
    return <EmptyState text="No decks yet — create one first, then come back to study." onBack={onExit} />
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Deck picker */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Select
          value={deckId}
          onValueChange={(v) => {
            setDeckId(v)
            setMode(startInBrowse && v === studyId ? 'browse' : 'idle')
          }}
        >
          <SelectTrigger className="w-full sm:w-72" aria-label="Choose deck">
            <SelectValue placeholder="Choose a deck" />
          </SelectTrigger>
          <SelectContent>
            {decks.map((d) => {
              const s = deckStats(d)
              return (
                <SelectItem key={d.id} value={d.id}>
                  {d.title} — {s.total} cards{s.due > 0 ? ` (${s.due} due)` : ''}
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setMode(mode === 'browse' ? 'idle' : 'browse')}>
            <List className="mr-2 h-4 w-4" /> Browse
          </Button>
          <Button size="sm" onClick={() => startSession(false)} disabled={!deck}>
            <GraduationCap className="mr-2 h-4 w-4" /> Study
          </Button>
          <Button variant="ghost" size="sm" onClick={() => startSession(true)} disabled={!deck}>
            <RotateCcw className="mr-2 h-4 w-4" /> All cards
          </Button>
        </div>
      </div>

      {mode === 'idle' && deck && <IdleScreen deck={deck} onStart={() => startSession(false)} />}
      {mode === 'browse' && deck && (
        <BrowseMode
          deck={deck}
          onEdit={saveEditedCard}
          onDelete={deleteCard}
          onAdd={addCard}
        />
      )}
      {mode === 'session' && deck && current && !finished && (
        <SessionView
          card={current}
          index={pos}
          total={queue.length}
          flipped={flipped}
          onFlip={() => setFlipped((f) => !f)}
          onRate={applyRating}
        />
      )}
      {finished && (
        <DoneScreen
          stats={stats}
          reviewed={queue.length}
          onRestart={() => startSession(false)}
          onExit={onExit}
        />
      )}
    </div>
  )
}

function IdleScreen({ deck, onStart }: { deck: Deck; onStart: () => void }) {
  const s = deckStats(deck)
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
        <GraduationCap className="h-10 w-10 text-emerald-600" />
        <div>
          <p className="font-medium">{deck.title}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {s.due > 0 && `${s.due} due for review · `}
            {s.fresh > 0 && `${s.fresh} new · `}
            {s.total} cards total
          </p>
          {s.due === 0 && s.fresh === 0 && (
            <p className="mt-2 text-sm text-muted-foreground">Nothing due right now — use “All cards” to cram anyway.</p>
          )}
        </div>
        <Button onClick={onStart}>
          <GraduationCap className="mr-2 h-4 w-4" /> Start session
        </Button>
        <p className="text-xs text-muted-foreground">Space = flip · 1–4 = rate (Again / Hard / Good / Easy)</p>
      </CardContent>
    </Card>
  )
}

function SessionView({
  card,
  index,
  total,
  flipped,
  onFlip,
  onRate,
}: {
  card: Flashcard
  index: number
  total: number
  flipped: boolean
  onFlip: () => void
  onRate: (q: Rating) => void
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Progress value={((index + 1) / total) * 100} />
        <span className="shrink-0 text-xs text-muted-foreground">
          {index + 1}/{total}
        </span>
      </div>

      <div className="flip-scene h-64 w-full cursor-pointer select-none sm:h-80" onClick={onFlip} role="button" aria-label="Flip card">
        <div className={cn('flip-inner', flipped && 'is-flipped')}>
          <Card className="flip-face">
            <CardContent className="flex h-full w-full flex-col items-center justify-center gap-4 overflow-auto p-6 text-center">
              <Badge variant="outline" className="text-xs text-muted-foreground">Question</Badge>
              <p className="text-lg font-medium leading-relaxed sm:text-xl">{card.question}</p>
              <p className="text-xs text-muted-foreground">click or press Space to reveal</p>
            </CardContent>
          </Card>
          <Card className="flip-face flip-back border-emerald-600/40 bg-emerald-600/5">
            <CardContent className="flex h-full w-full flex-col items-center justify-center gap-4 overflow-auto p-6 text-center">
              <Badge variant="outline" className="border-emerald-600/40 text-xs text-emerald-600">Answer</Badge>
              <p className="text-base leading-relaxed sm:text-lg">{card.answer}</p>
            </CardContent>
          </Card>
        </div>
      </div>

      {flipped ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {RATINGS.map((r) => (
            <Button key={r.q} className={cn('h-11', r.cls)} onClick={() => onRate(r.q)}>
              {r.label}
              <span className="ml-1.5 hidden text-xs opacity-80 sm:inline">
                {intervalLabel(card.progress, r.q)}
              </span>
            </Button>
          ))}
        </div>
      ) : (
        <Button variant="outline" className="w-full" onClick={onFlip}>
          <Eye className="mr-2 h-4 w-4" /> Show answer
        </Button>
      )}
    </div>
  )
}

function DoneScreen({
  stats,
  reviewed,
  onRestart,
  onExit,
}: {
  stats: SessionStat
  reviewed: number
  onRestart: () => void
  onExit: () => void
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-5 py-12 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-600/10">
          <GraduationCap className="h-7 w-7 text-emerald-600" />
        </div>
        <div>
          <p className="text-lg font-semibold">Session complete — {reviewed} cards reviewed</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {stats.again} again · {stats.hard} hard · {stats.good} good · {stats.easy} easy
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            Progress saved in this browser. Cards rated “Again” return in 10 minutes.
          </p>
        </div>
        <div className="flex gap-3">
          <Button variant="outline" onClick={onRestart}>
            <RotateCcw className="mr-2 h-4 w-4" /> Study again
          </Button>
          <Button onClick={onExit}>Back to decks</Button>
        </div>
      </CardContent>
    </Card>
  )
}

function BrowseMode({
  deck,
  onEdit,
  onDelete,
  onAdd,
}: {
  deck: Deck
  onEdit: (id: string, q: string, a: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onAdd: (q: string, a: string) => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Flashcard | null>(null)
  const [eq, setEq] = useState('')
  const [ea, setEa] = useState('')
  const [adding, setAdding] = useState(false)
  const [nq, setNq] = useState('')
  const [na, setNa] = useState('')

  const filtered = deck.cards.filter(
    (c) => !query || c.question.toLowerCase().includes(query.toLowerCase()) || c.answer.toLowerCase().includes(query.toLowerCase()),
  )

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter cards…" />
        <Button variant="outline" onClick={() => { setAdding(true); setNq(''); setNa('') }}>
          <Plus className="mr-2 h-4 w-4" /> Add
        </Button>
      </div>

      <ScrollArea className="max-h-[60vh] rounded-lg border">
        <div className="divide-y">
          {filtered.map((c) => (
            <div key={c.id} className="group flex items-start gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{c.question}</p>
                <p className="truncate text-xs text-muted-foreground">{c.answer}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {isNew(c.progress) ? 'new' : `ease ${c.progress.ease.toFixed(2)} · interval ${c.progress.interval}d`}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditing(c)
                  setEq(c.question)
                  setEa(c.answer)
                }}
                aria-label="Edit card"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => void onDelete(c.id)}
                aria-label="Delete card"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {filtered.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">No cards match.</p>}
        </div>
      </ScrollArea>

      {/* Edit dialog */}
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit card</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Question</label>
              <Textarea value={eq} onChange={(e) => setEq(e.target.value)} className="min-h-20" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Answer</label>
              <Textarea value={ea} onChange={(e) => setEa(e.target.value)} className="min-h-20" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              <ChevronLeft className="mr-2 h-4 w-4" /> Cancel
            </Button>
            <Button
              onClick={() => {
                if (editing && eq.trim() && ea.trim()) {
                  void onEdit(editing.id, eq.trim(), ea.trim())
                  setEditing(null)
                }
              }}
            >
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add dialog */}
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add card to “{deck.title}”</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea value={nq} onChange={(e) => setNq(e.target.value)} placeholder="Question" className="min-h-20" />
            <Textarea value={na} onChange={(e) => setNa(e.target.value)} placeholder="Answer" className="min-h-20" />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (nq.trim() && na.trim()) {
                  void onAdd(nq.trim(), na.trim())
                  setAdding(false)
                }
              }}
            >
              Add card
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function EmptyState({ text, onBack }: { text: string; onBack: () => void }) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
        <GraduationCap className="h-10 w-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{text}</p>
        <Button variant="outline" onClick={onBack}>
          Back to decks
        </Button>
      </CardContent>
    </Card>
  )
}
