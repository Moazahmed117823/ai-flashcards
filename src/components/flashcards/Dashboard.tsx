'use client'

import { useMemo, useState } from 'react'
import { AlertTriangle, Brain, FileDown, Layers, Plus, Search, Trash2 } from 'lucide-react'
import type { Deck } from '@/lib/types'
import { deckStats } from '@/lib/srs'
import { deckToTsv, downloadFile, slugify } from '@/lib/storage'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface Props {
  decks: Deck[]
  onCreate: () => void
  onStudy: (deckId: string, browse?: boolean) => void
  onDelete: (deckId: string) => void
}

export function Dashboard({ decks, onCreate, onStudy, onDelete }: Props) {
  const [query, setQuery] = useState('')
  const [subject, setSubject] = useState<string>('All')

  const subjects = useMemo(() => ['All', ...Array.from(new Set(decks.map((d) => d.subject))).sort()], [decks])

  const totals = useMemo(() => {
    let cards = 0
    let due = 0
    let fresh = 0
    for (const d of decks) {
      const s = deckStats(d)
      cards += s.total
      due += s.due
      fresh += s.fresh
    }
    return { decks: decks.length, cards, due, fresh }
  }, [decks])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return decks.filter((d) => {
      if (subject !== 'All' && d.subject !== subject) return false
      if (!q) return true
      return (
        d.title.toLowerCase().includes(q) ||
        d.topic.toLowerCase().includes(q) ||
        d.tags.some((t) => t.toLowerCase().includes(q)) ||
        d.cards.some((c) => c.question.toLowerCase().includes(q) || c.answer.toLowerCase().includes(q))
      )
    })
  }, [decks, query, subject])

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Decks" value={totals.decks} icon={<Layers className="h-4 w-4" />} />
        <StatCard label="Cards" value={totals.cards} icon={<Brain className="h-4 w-4" />} />
        <StatCard label="Due now" value={totals.due} icon={<AlertTriangle className="h-4 w-4" />} accent />
        <StatCard label="New" value={totals.fresh} icon={<Plus className="h-4 w-4" />} />
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search decks, questions, answers, tags…"
            className="pl-9"
            aria-label="Search decks"
          />
        </div>
        <Button onClick={onCreate} className="shrink-0">
          <Plus className="mr-2 h-4 w-4" /> New deck
        </Button>
      </div>

      {subjects.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {subjects.map((s) => (
            <button
              key={s}
              onClick={() => setSubject(s)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                subject === s
                  ? 'border-emerald-600 bg-emerald-600 text-white'
                  : 'border-border bg-transparent text-muted-foreground hover:bg-muted',
              )}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Deck grid */}
      {filtered.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
            <Layers className="h-10 w-10 text-muted-foreground" />
            <div>
              <p className="font-medium">{decks.length === 0 ? 'No decks yet' : 'No decks match your filters'}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {decks.length === 0
                  ? 'Paste your notes or upload a PDF and let the AI build your first deck.'
                  : 'Try a different search or subject filter.'}
              </p>
            </div>
            {decks.length === 0 && (
              <Button onClick={onCreate}>
                <Plus className="mr-2 h-4 w-4" /> Create your first deck
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((deck) => {
            const s = deckStats(deck)
            return (
              <Card key={deck.id} className="flex flex-col transition-shadow hover:shadow-md">
                <CardHeader className="pb-2">
                  <CardTitle className="line-clamp-2 text-base leading-snug">{deck.title}</CardTitle>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <Badge variant="secondary" className="font-normal">
                      {deck.subject}
                    </Badge>
                    {deck.system && deck.system !== '-' && (
                      <Badge variant="outline" className="font-normal">
                        {deck.system}
                      </Badge>
                    )}
                    {s.due > 0 && (
                      <Badge className="bg-emerald-600 font-normal text-white">{s.due} due</Badge>
                    )}
                    {s.fresh > 0 && (
                      <Badge variant="outline" className="font-normal text-muted-foreground">
                        {s.fresh} new
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="flex-1 pb-2">
                  <p className="text-xs text-muted-foreground">
                    {deck.cards.length} cards · {deck.topic}
                    {deck.tags.length > 0 && ` · ${deck.tags.slice(0, 3).map((t) => `#${t}`).join(' ')}`}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Created {new Date(deck.createdAt).toLocaleDateString()}
                  </p>
                </CardContent>
                <CardFooter className="gap-2 border-t pt-3">
                  <Button size="sm" className="flex-1" onClick={() => onStudy(deck.id)}>
                    Study
                  </Button>
                  <Button size="sm" variant="outline" className="flex-1" onClick={() => onStudy(deck.id, true)}>
                    Browse
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Export deck for Anki (TSV)"
                    onClick={() => downloadFile(`${slugify(deck.title)}.txt`, deckToTsv(deck), 'text/plain')}
                  >
                    <FileDown className="h-4 w-4" />
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete “{deck.title}”?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This permanently removes the deck and all its study progress from this browser. Export it
                          first if you want a backup.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-destructive text-white hover:bg-destructive/90"
                          onClick={() => onDelete(deck.id)}
                        >
                          Delete deck
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </CardFooter>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

function StatCard({
  label,
  value,
  icon,
  accent,
}: {
  label: string
  value: number
  icon: React.ReactNode
  accent?: boolean
}) {
  return (
    <Card className={cn('py-4', accent && value > 0 && 'border-emerald-600/40 bg-emerald-600/5')}>
      <CardContent className="flex items-center gap-3 px-4">
        <div
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-lg',
            accent && value > 0 ? 'bg-emerald-600 text-white' : 'bg-muted text-muted-foreground',
          )}
        >
          {icon}
        </div>
        <div>
          <p className="text-xl font-semibold leading-none">{value}</p>
          <p className="mt-1 text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  )
}
