'use client'

import { useEffect, useRef, useState } from 'react'
import { CircleAlert, FileText, History, Loader2, ShieldCheck, Sparkles, Square, Upload, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import type { DeckMeta, Difficulty, Draft, PipelineCheckpoint, PipelineProgress } from '@/lib/types'
import { ACCEPTED, extractFile } from '@/lib/extract'
import { buildChunks, clearCheckpoint, checkpointId, loadCheckpoint, runPipeline, saveCheckpoint } from '@/lib/pipeline'
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

const fmtEta = (sec?: number): string => {
  if (!sec || sec <= 0) return ''
  if (sec < 90) return `~${Math.round(sec)}s left`
  return `~${Math.round(sec / 60)} min left`
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
  const [deep, setDeep] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<PipelineProgress | null>(null)
  const [resume, setResume] = useState<PipelineCheckpoint | null>(null)
  const handleRef = useRef<{ aborted: boolean } | null>(null)

  const activeText = tab === 'paste' ? text : (fileData?.text ?? '')

  useEffect(() => {
    setResume(loadCheckpoint())
  }, [])

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

  function startRun(cp?: PipelineCheckpoint) {
    const source = cp?.source ?? activeText.trim()
    const opts = cp?.opts ?? {
      count,
      difficulty,
      language,
      verify,
      deep,
      sourceName: tab === 'file' ? fileData?.name : undefined,
    }
    if (!cp && source.length < 40) {
      toast.error('Provide more source material first — paste notes or upload a file.')
      return
    }
    const previewChunks = cp?.chunks ?? buildChunks(source, opts.difficulty)
    if (!cp && previewChunks.length > 40) {
      toast.error('This source is very large. Split it into parts (per chapter/lecture) and generate one at a time.')
      return
    }

    const handle = { aborted: false }
    handleRef.current = handle
    setBusy(true)
    setResume(null)

    void runPipeline({
      source,
      opts,
      handle,
      checkpoint: cp,
      hooks: {
        onProgress: (p) => setProgress(p),
      },
    })
      .then((result) => {
        if (result.aborted) {
          toast.info(`Stopped — ${result.cards.length} cards kept. You can resume later.`)
          setResume(loadCheckpoint())
          return
        }
        if (result.cards.length === 0) {
          toast.error('No cards were produced. Try adjusting the options and regenerate.')
          return
        }
        const summary = result.stats?.duplicatesMerged
          ? ` · ${result.stats.duplicatesMerged} duplicate${result.stats.duplicatesMerged > 1 ? 's' : ''} merged`
          : ''
        toast.success(`${result.cards.length} cards ready${summary} — review them before saving.`)
        onDraft(result)
      })
      .catch((e: unknown) => {
        toast.error(e instanceof Error ? e.message : 'Generation failed.')
        setResume(loadCheckpoint())
      })
      .finally(() => {
        setBusy(false)
        setProgress(null)
        handleRef.current = null
      })
  }

  function stop() {
    if (handleRef.current) handleRef.current.aborted = true
  }

  function discardResume() {
    clearCheckpoint()
    setResume(null)
    toast.info('Unfinished generation discarded.')
  }

  const partsLabel =
    progress && progress.partsTotal > 1
      ? `Part ${Math.min(progress.partsDone + 1, progress.partsTotal)}/${progress.partsTotal}`
      : null

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Create a deck</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Cards are generated strictly from <span className="font-medium">your material</span> — the model never invents
          facts. Paste notes or dump a file, pick options, review, save. Big files are processed section by section with
          resumable checkpoints.
        </p>
      </div>

      {resume && !busy && (
        <Card className="border-amber-600/40 bg-amber-600/5">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2">
              <History className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="text-sm">
                <p className="font-medium">Unfinished generation found</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {resume.doneCount}/{resume.chunks.length} parts done · {resume.cards.length} cards so far
                  {resume.opts.sourceName ? ` · ${resume.opts.sourceName}` : ''}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={discardResume}>
                Discard
              </Button>
              <Button size="sm" onClick={() => startRun(resume)}>
                <Sparkles className="mr-2 h-3.5 w-3.5" /> Resume
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

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
          <p className="mt-2 text-xs text-muted-foreground">
            {text.length.toLocaleString()} characters
            {text.length > 3000 && ` · ≈ ${buildChunks(text, difficulty).length} parts`}
          </p>
        </TabsContent>

        <TabsContent value="file" className="mt-4">
          <label
            onDragOver={(e) => {
              e.preventDefault()
              e.currentTarget.classList.add('border-emerald-600', 'bg-emerald-600/5')
            }}
            onDragLeave={(e) => e.currentTarget.classList.remove('border-emerald-600', 'bg-emerald-600/5')}
            onDrop={(e) => {
              e.preventDefault()
              e.currentTarget.classList.remove('border-emerald-600', 'bg-emerald-600/5')
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
                  {fileData.pages ? ` · ${fileData.pages} pages` : ''} · ≈{' '}
                  {buildChunks(fileData.text, difficulty).length} parts — click to replace
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
            <p className="text-xs text-muted-foreground">Big files are split into parts; each part gets a share of this budget.</p>
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
            <Switch id="verify" checked={verify} onCheckedChange={setVerify} />
            <div>
              <Label htmlFor="verify" className="flex items-center gap-1.5">
                <ShieldCheck className="h-4 w-4 text-emerald-600" /> Precision mode (recommended for medical content)
              </Label>
              <p className="mt-1 text-xs text-muted-foreground">
                The model re-checks every part against your source right after generating it, flags anything it cannot
                support. Slightly slower — still free.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 sm:col-span-2">
            <Switch id="deep" checked={deep} onCheckedChange={setDeep} />
            <div>
              <Label htmlFor="deep" className="flex items-center gap-1.5">
                <Wand2 className="h-4 w-4 text-violet-600" /> Deep processing (best for long files)
              </Label>
              <p className="mt-1 text-xs text-muted-foreground">
                Adds a planning pass (smarter card distribution across sections) and writes integration cards that
                connect adjacent sections. A few extra API calls.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {busy && progress && (
        <div className="space-y-2">
          <Progress value={progress.pct} />
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {progress.label}
          </p>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {partsLabel ? `${partsLabel} · ` : ''}
              {progress.cardsSoFar} cards so far
              {progress.retryInSec !== undefined ? ' · paused' : ''}
            </span>
            <span>{fmtEta(progress.etaSec)}</span>
          </div>
          {progress.retryInSec !== undefined && (
            <p className="flex items-center gap-1.5 text-xs text-amber-600">
              <CircleAlert className="h-3.5 w-3.5" /> Your progress is saved — generation resumes automatically.
            </p>
          )}
        </div>
      )}

      {busy ? (
        <Button size="lg" variant="outline" className="w-full" onClick={stop}>
          <Square className="mr-2 h-4 w-4" /> Stop — keep {progress?.cardsSoFar ?? 0} cards
        </Button>
      ) : (
        <Button size="lg" className="w-full" onClick={() => startRun()} disabled={extracting}>
          <Sparkles className="mr-2 h-4 w-4" /> Generate flashcards
        </Button>
      )}
    </div>
  )
}
