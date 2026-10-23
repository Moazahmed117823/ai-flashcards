'use client'

import { useRef, useState } from 'react'
import { FileText, Loader2, ShieldCheck, Sparkles, Upload } from 'lucide-react'
import { toast } from 'sonner'
import type { DeckMeta, Difficulty, Draft, GeneratedCard } from '@/lib/types'
import { ACCEPTED, chunkText, extractFile } from '@/lib/extract'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'

const LANGUAGES = ['Auto (match source)', 'English', 'العربية', 'Français', 'Español', 'Deutsch', 'Türkçe', 'Português', '中文', 'हिन्दी']

interface Props {
  onDraft: (draft: Draft) => void
}

export function CreatePanel({ onDraft }: Props) {
  const [tab, setTab] = useState<'paste' | 'file'>('paste')
  const [text, setText] = useState('')
  const [fileData, setFileData] = useState<{ name: string; text: string; pages?: number } | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [count, setCount] = useState(15)
  const [difficulty, setDifficulty] = useState<Difficulty>('mixed')
  const [language, setLanguage] = useState('Auto (match source)')
  const [verify, setVerify] = useState(false)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [pct, setPct] = useState(0)
  const dropRef = useRef<HTMLLabelElement>(null)

  const activeText = tab === 'paste' ? text : (fileData?.text ?? '')

  async function handleFile(f: File | undefined) {
    if (!f) return
    setExtracting(true)
    try {
      const ex = await extractFile(f)
      if (ex.text.trim().length < 40) {
        throw new Error('No extractable text found (scanned/image PDFs are not supported yet — copy the text instead).')
      }
      setFileData({ name: ex.name, text: ex.text, pages: ex.pages })
      toast.success(`Extracted ${ex.text.length.toLocaleString()} characters from ${ex.name}`)
    } catch (e) {
      setFileData(null)
      toast.error(e instanceof Error ? e.message : 'Could not read that file.')
    } finally {
      setExtracting(false)
    }
  }

  async function generate() {
    const source = activeText.trim()
    if (source.length < 40) {
      toast.error('Provide more source material first — paste notes or upload a file.')
      return
    }
    const chunks = chunkText(source)
    if (chunks.length > 6) {
      toast.error('This source is very large. Split it into parts (per chapter/lecture) and generate one at a time.')
      return
    }

    setBusy(true)
    setPct(5)
    setStage(chunks.length > 1 ? 'Preparing sections…' : 'Generating cards…')
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      try {
        const userKey = localStorage.getItem('zai_user_key')
        if (userKey) headers['x-user-key'] = userKey
      } catch {
        /* ignore */
      }

      const all: GeneratedCard[] = []
      let meta: DeckMeta | null = null

      for (let i = 0; i < chunks.length; i++) {
        setStage(
          chunks.length > 1
            ? `Section ${i + 1}/${chunks.length} — generating cards…`
            : 'Generating cards — usually a few seconds…',
        )
        setPct(5 + Math.round((i / chunks.length) * 70))
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers,
          body: JSON.stringify({ source: chunks[i], count, difficulty, language }),
        })
        const data = (await res.json().catch(() => ({}))) as { error?: string; meta?: DeckMeta; cards?: GeneratedCard[] }
        if (!res.ok) throw new Error(data.error || `Generation failed (${res.status})`)
        if (!meta && data.meta) meta = data.meta
        if (data.cards) all.push(...data.cards)
      }

      let finalCards = all

      if (verify && all.length > 0) {
        setStage('Precision check — verifying every card against the source…')
        setPct(80)
        const BATCH = 20
        const batches: GeneratedCard[][] = []
        for (let i = 0; i < all.length; i += BATCH) batches.push(all.slice(i, i + BATCH))

        finalCards = []
        let okN = 0
        let fixedN = 0
        let removedN = 0
        let failed = false
        let lastError = ''

        for (let b = 0; b < batches.length; b++) {
          if (batches.length > 1) {
            setStage(`Precision check — batch ${b + 1}/${batches.length}…`)
            setPct(80 + Math.round((b / batches.length) * 15))
          }
          let done = false
          // up to 3 attempts per batch — the free tier intermittently 429s right after a generation call
          for (const waitSec of [0, 8, 15]) {
            if (waitSec > 0) {
              setStage(`Free tier busy — retrying precision check in ${waitSec}s…`)
              await new Promise((r) => setTimeout(r, waitSec * 1000))
            }
            try {
              const vres = await fetch('/api/verify', {
                method: 'POST',
                headers,
                body: JSON.stringify({ source: chunks.join('\n\n').slice(0, 80_000), cards: batches[b] }),
              })
              const vdata = (await vres.json().catch(() => ({}))) as { error?: string; cards?: GeneratedCard[] }
              if (vres.ok && Array.isArray(vdata.cards) && vdata.cards.length > 0) {
                finalCards.push(...vdata.cards)
                done = true
                break
              }
              lastError = vdata.error ?? `HTTP ${vres.status}`
            } catch {
              lastError = 'network error'
            }
          }
          if (!done) {
            // keep the unverified cards rather than losing them, and stop trying further batches
            failed = true
            finalCards.push(...batches.slice(b).flat())
            break
          }
        }

        for (const c of finalCards) {
          if (c.verdict === 'fixed') fixedN++
          else if (c.verdict === 'removed') removedN++
          else okN++
        }
        setPct(98)
        if (failed) {
          toast.warning(
            `Precision check incomplete (${lastError}) — free tier is busy. Cards were kept unverified; review carefully or regenerate.`,
          )
        } else {
          toast.success(`Precision check done — ${okN} verified · ${fixedN} corrected · ${removedN} unsupported`)
        }
      }

      if (finalCards.length === 0) throw new Error('No cards were produced. Try adjusting the options and regenerate.')
      setPct(100)
      toast.success(`${finalCards.length} cards ready — review them before saving.`)
      onDraft({ meta: meta ?? fallbackMeta(), cards: finalCards, sourceExcerpt: source.slice(0, 400) })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Generation failed.')
    } finally {
      setBusy(false)
      setStage('')
      setPct(0)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Create a deck</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Cards are generated strictly from <span className="font-medium">your material</span> — the model never invents
          facts. Paste notes or dump a file, pick options, review, save.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'paste' | 'file')}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="paste">Paste text</TabsTrigger>
          <TabsTrigger value="file">Upload file</TabsTrigger>
        </TabsList>

        <TabsContent value="paste" className="mt-4">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'Paste lecture notes, a textbook section, a transcript…\n\nTip: for medical precision, include the actual numbers, cutoffs and criteria from your resource.'}
            className="min-h-56 resize-y font-mono text-sm"
            aria-label="Source text"
          />
          <p className="mt-2 text-xs text-muted-foreground">{text.length.toLocaleString()} characters</p>
        </TabsContent>

        <TabsContent value="file" className="mt-4">
          <label
            ref={dropRef}
            onDragOver={(e) => {
              e.preventDefault()
              dropRef.current?.classList.add('border-emerald-600', 'bg-emerald-600/5')
            }}
            onDragLeave={() => dropRef.current?.classList.remove('border-emerald-600', 'bg-emerald-600/5')}
            onDrop={(e) => {
              e.preventDefault()
              dropRef.current?.classList.remove('border-emerald-600', 'bg-emerald-600/5')
              void handleFile(e.dataTransfer.files?.[0])
            }}
            className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-border px-6 py-12 text-center transition-colors hover:bg-muted/50"
          >
            <input
              type="file"
              accept={ACCEPTED}
              className="sr-only"
              onChange={(e) => void handleFile(e.target.files?.[0])}
              disabled={extracting}
            />
            {extracting ? (
              <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
            ) : (
              <Upload className="h-8 w-8 text-muted-foreground" />
            )}
            {fileData ? (
              <div>
                <p className="flex items-center justify-center gap-2 font-medium">
                  <FileText className="h-4 w-4 text-emerald-600" /> {fileData.name}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {fileData.text.length.toLocaleString()} characters extracted
                  {fileData.pages ? ` · ${fileData.pages} pages` : ''} — click to replace
                </p>
              </div>
            ) : (
              <div>
                <p className="font-medium">Drop a file here or click to browse</p>
                <p className="mt-1 text-xs text-muted-foreground">PDF, DOCX, TXT or MD — text is extracted in your browser</p>
              </div>
            )}
          </label>
        </TabsContent>
      </Tabs>

      {/* Options */}
      <Card>
        <CardContent className="grid gap-5 p-4 sm:grid-cols-2">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="count">Cards to generate</Label>
              <span className="text-sm font-medium text-emerald-600">{count}</span>
            </div>
            <Slider id="count" min={3} max={40} step={1} value={[count]} onValueChange={([v]) => setCount(v)} />
            <p className="text-xs text-muted-foreground">Long files are split into sections; each gets its own batch.</p>
          </div>

          <div className="space-y-3">
            <Label>Difficulty</Label>
            <Select value={difficulty} onValueChange={(v) => setDifficulty(v as Difficulty)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="easy">Easy — definitions & recall</SelectItem>
                <SelectItem value="medium">Medium — mechanisms & application</SelectItem>
                <SelectItem value="hard">Hard — integration & edge cases</SelectItem>
                <SelectItem value="mixed">Mixed blend</SelectItem>
              </SelectContent>
            </Select>
            <Label className="sr-only">Language</Label>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l} value={l}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-start gap-3 sm:col-span-2">
            <Switch id="verify" checked={verify} onValueChange={setVerify} />
            <div>
              <Label htmlFor="verify" className="flex items-center gap-1.5">
                <ShieldCheck className="h-4 w-4 text-emerald-600" /> Precision mode (recommended for medical content)
              </Label>
              <p className="mt-1 text-xs text-muted-foreground">
                Adds a second pass where the model re-checks every card against your source and flags anything it
                cannot support. Slightly slower — still free.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {busy && (
        <div className="space-y-2">
          <Progress value={pct} />
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {stage}
          </p>
          <p className="text-xs text-muted-foreground">
            Generations are queued one at a time on the free tier — if others are studying too, yours may wait briefly.
          </p>
        </div>
      )}

      <Button size="lg" className="w-full" onClick={() => void generate()} disabled={busy || extracting}>
        {busy ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Working…
          </>
        ) : (
          <>
            <Sparkles className="mr-2 h-4 w-4" /> Generate flashcards
          </>
        )}
      </Button>
    </div>
  )
}

function fallbackMeta(): DeckMeta {
  return { deckTitle: 'Untitled deck', subject: 'General', system: '-', topic: '-', tags: [] }
}
