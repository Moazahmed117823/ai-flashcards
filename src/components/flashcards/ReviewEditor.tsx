'use client'

import { useMemo, useState } from 'react'
import { ArrowLeft, ChevronDown, CircleAlert, CircleCheck, CircleMinus, Plus, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Deck, Draft } from '@/lib/types'
import { newCard, uid } from '@/lib/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

interface Row {
  id: string
  question: string
  answer: string
  verdict?: 'ok' | 'fixed' | 'removed'
  note?: string
  section?: string
}

interface Props {
  draft: Draft
  onSave: (deck: Deck) => void
  onCancel: () => void
}

export function ReviewEditor({ draft, onSave, onCancel }: Props) {
  const [title, setTitle] = useState(draft.meta.deckTitle)
  const [subject, setSubject] = useState(draft.meta.subject)
  const [system, setSystem] = useState(draft.meta.system)
  const [topic, setTopic] = useState(draft.meta.topic)
  const [tagsStr, setTagsStr] = useState(draft.meta.tags.join(', '))
  const [rows, setRows] = useState<Row[]>(() =>
    draft.cards.map((c) => ({ id: uid(), question: c.question, answer: c.answer, verdict: c.verdict, note: c.note, section: c.section })),
  )
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const orderedSections = useMemo(() => {
    const names: string[] = []
    for (const s of draft.sections ?? []) if (!names.includes(s)) names.push(s)
    for (const r of rows) if (r.section && !names.includes(r.section)) names.push(r.section)
    return names.length > 0 ? names : ['Cards']
  }, [draft.sections, rows])

  const emptySections = useMemo(
    () => (draft.sections ?? []).filter((s) => !rows.some((r) => r.section === s)),
    [draft.sections, rows],
  )
  const duplicatesMerged = draft.stats?.duplicatesMerged ?? 0

  const update = (id: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))

  function save() {
    const clean = rows.filter((r) => r.question.trim() && r.answer.trim())
    if (!title.trim()) {
      toast.error('Give the deck a title first.')
      return
    }
    if (clean.length === 0) {
      toast.error('The deck has no complete cards left — add or restore at least one.')
      return
    }
    const deck: Deck = {
      id: uid(),
      title: title.trim(),
      subject: subject.trim() || 'General',
      system: system.trim() || '-',
      topic: topic.trim() || '-',
      tags: tagsStr
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 10),
      sourceExcerpt: draft.sourceExcerpt,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cards: clean.map((r) => newCard(r.question.trim(), r.answer.trim())),
    }
    onSave(deck)
  }

  const flagged = rows.filter((r) => r.verdict === 'removed').length
  const fixed = rows.filter((r) => r.verdict === 'fixed').length

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Review & edit</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {rows.length} cards generated. Fix wording, delete weak cards, then save to this browser.
          </p>
        </div>
        <Button variant="ghost" onClick={onCancel}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Discard
        </Button>
      </div>

      {(flagged > 0 || fixed > 0) && (
        <div className="flex flex-wrap gap-2 rounded-lg border border-amber-600/30 bg-amber-600/5 p-3 text-sm">
          {fixed > 0 && (
            <span className="flex items-center gap-1.5">
              <CircleAlert className="h-4 w-4 text-amber-600" /> {fixed} card{fixed > 1 ? 's' : ''} auto-corrected
            </span>
          )}
          {flagged > 0 && (
            <span className="flex items-center gap-1.5">
              <CircleMinus className="h-4 w-4 text-red-600" /> {flagged} card{flagged > 1 ? 's' : ''} could not be
              verified against your source — check or delete them
            </span>
          )}
        </div>
      )}

      {/* Metadata */}
      <Card>
        <CardContent className="grid gap-4 p-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="d-title">Deck title</Label>
            <Input id="d-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="d-subject">Subject</Label>
            <Input id="d-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="d-system">System / subfield</Label>
            <Input id="d-system" value={system} onChange={(e) => setSystem(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="d-topic">Topic</Label>
            <Input id="d-topic" value={topic} onChange={(e) => setTopic(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="d-tags">Tags (comma separated)</Label>
            <Input id="d-tags" value={tagsStr} onChange={(e) => setTagsStr(e.target.value)} placeholder="usmle, step1, cardio" />
          </div>
        </CardContent>
      </Card>

      {(duplicatesMerged > 0 || emptySections.length > 0) && (
        <div className="flex flex-col gap-1 rounded-lg border border-sky-600/30 bg-sky-600/5 p-3 text-sm text-sky-700 dark:text-sky-400">
          {duplicatesMerged > 0 && (
            <span>
              {duplicatesMerged} duplicate card{duplicatesMerged > 1 ? 's' : ''} automatically merged during linking.
            </span>
          )}
          {emptySections.length > 0 && (
            <span>
              No cards were produced for: {emptySections.join(', ')} — that part may be scanned/empty, or worth generating
              separately.
            </span>
          )}
        </div>
      )}

      {/* Cards — grouped by section */}
      <div className="space-y-5">
        {orderedSections.map((section) => {
          const sectionRows = rows.filter((r) => (r.section ?? 'Cards') === section || (orderedSections.length === 1 && !r.section))
          if (sectionRows.length === 0) return null
          const isCollapsed = collapsed[section] === true
          return (
            <div key={section} className="space-y-3">
              {orderedSections.length > 1 && (
                <button
                  type="button"
                  onClick={() => setCollapsed((c) => ({ ...c, [section]: !c[section] }))}
                  className="flex w-full items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-left text-sm font-medium hover:bg-muted"
                >
                  <ChevronDown className={`h-4 w-4 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
                  {section}
                  <span className="ml-auto text-xs text-muted-foreground">{sectionRows.length} cards</span>
                </button>
              )}
              {!isCollapsed &&
                sectionRows.map((r) => {
                  const i = rows.indexOf(r)
                  return (
                    <Card key={r.id} className={r.verdict === 'removed' ? 'border-red-600/40' : undefined}>
                      <CardContent className="space-y-3 p-4">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-muted-foreground">#{i + 1}</span>
                            {r.verdict === 'ok' && (
                              <Badge variant="outline" className="gap-1 border-emerald-600/40 text-emerald-600">
                                <CircleCheck className="h-3 w-3" /> verified
                              </Badge>
                            )}
                            {r.verdict === 'fixed' && (
                              <Badge variant="outline" className="gap-1 border-amber-600/40 text-amber-600">
                                <CircleAlert className="h-3 w-3" /> corrected
                              </Badge>
                            )}
                            {r.verdict === 'removed' && (
                              <Badge variant="outline" className="gap-1 border-red-600/40 text-red-600">
                                <CircleMinus className="h-3 w-3" /> unsupported
                              </Badge>
                            )}
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}
                            aria-label={`Delete card ${i + 1}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                        {r.note && r.verdict !== 'ok' && (
                          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{r.note}</p>
                        )}
                        <div className="grid gap-3 md:grid-cols-2">
                          <div className="space-y-1.5">
                            <Label className="text-xs text-muted-foreground">Question</Label>
                            <Textarea
                              value={r.question}
                              onChange={(e) => update(r.id, { question: e.target.value })}
                              className="min-h-20 resize-y text-sm"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs text-muted-foreground">Answer</Label>
                            <Textarea
                              value={r.answer}
                              onChange={(e) => update(r.id, { answer: e.target.value })}
                              className="min-h-20 resize-y text-sm"
                            />
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
            </div>
          )
        })}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Button
          variant="outline"
          className="flex-1"
          onClick={() => setRows((rs) => [...rs, { id: uid(), question: '', answer: '' }])}
        >
          <Plus className="mr-2 h-4 w-4" /> Add card manually
        </Button>
        <Button className="flex-1" onClick={save} disabled={rows.length === 0}>
          <Save className="mr-2 h-4 w-4" /> Save deck ({rows.filter((r) => r.question.trim() && r.answer.trim()).length} cards)
        </Button>
      </div>
    </div>
  )
}
