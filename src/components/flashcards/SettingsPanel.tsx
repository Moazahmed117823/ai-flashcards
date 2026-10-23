'use client'

import { useEffect, useState } from 'react'
import { Database, Download, HardDriveDownload, KeyRound, ShieldAlert, Upload } from 'lucide-react'
import { toast } from 'sonner'
import type { Deck } from '@/lib/types'
import { clearAllDecks, downloadFile, exportAll, importDecks, storageEstimate } from '@/lib/storage'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
import { Separator } from '@/components/ui/separator'

interface Props {
  decks: Deck[]
  onChanged: () => void
}

export function SettingsPanel({ decks, onChanged }: Props) {
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null)
  const [userKey, setUserKey] = useState('')
  const totalCards = decks.reduce((n, d) => n + d.cards.length, 0)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      storageEstimate(),
      Promise.resolve().then(() => {
        try {
          return localStorage.getItem('zai_user_key') ?? ''
        } catch {
          return ''
        }
      }),
    ]).then(([est, key]) => {
      if (cancelled) return
      setEstimate(est)
      setUserKey(key)
    })
    return () => {
      cancelled = true
    }
  }, [])

  function handleImport(file: File | undefined) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const res = await importDecks(String(reader.result))
        onChanged()
        toast.success(`Imported ${res.added} new, ${res.updated} updated decks.`)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Import failed.')
      }
    }
    reader.readAsText(file)
  }

  function saveKey() {
    try {
      if (userKey.trim()) localStorage.setItem('zai_user_key', userKey.trim())
      else localStorage.removeItem('zai_user_key')
      toast.success(userKey.trim() ? 'Personal key saved in this browser.' : 'Personal key removed.')
    } catch {
      toast.error('Could not access browser storage.')
    }
  }

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
    return `${(n / 1024 ** 3).toFixed(2)} GB`
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Settings</h2>
        <p className="mt-1 text-sm text-muted-foreground">Backups, data, and your optional personal model key.</p>
      </div>

      {/* Storage */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4 text-emerald-600" /> Local storage
          </CardTitle>
          <CardDescription>
            {decks.length} decks · {totalCards} cards — all data lives in this browser (IndexedDB), nothing is stored on
            a server.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {estimate && (
            <p className="text-sm text-muted-foreground">
              Using {fmtBytes(estimate.usage)} of ~{fmtBytes(estimate.quota)} available — flashcards are tiny text, this
              is years of studying.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => downloadFile(`ai-flashcards-backup-${new Date().toISOString().slice(0, 10)}.json`, exportAll(decks))}>
              <Download className="mr-2 h-4 w-4" /> Export backup (JSON)
            </Button>
            <label>
              <input
                type="file"
                accept=".json"
                className="sr-only"
                onChange={(e) => handleImport(e.target.files?.[0])}
              />
              <Button variant="outline" asChild>
                <span className="cursor-pointer">
                  <Upload className="mr-2 h-4 w-4" /> Import backup
                </span>
              </Button>
            </label>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" className="text-destructive hover:text-destructive">
                  <HardDriveDownload className="mr-2 h-4 w-4" /> Delete all data
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete everything?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This wipes every deck, all study progress and settings from this browser. Export a backup first —
                    there is no server copy.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-white hover:bg-destructive/90"
                    onClick={() => {
                      void clearAllDecks().then(() => {
                        onChanged()
                        toast.success('All local data deleted.')
                      })
                    }}
                  >
                    Delete everything
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardContent>
      </Card>

      {/* Personal key */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4 text-emerald-600" /> Personal API key (optional)
          </CardTitle>
          <CardDescription>
            The site already works with its own free model key. If the queue is busy, you can paste your own free Z.ai
            key (from the Z.ai API platform) to jump the line. It is stored only in this browser and sent only with
            your generation requests.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Input
            type="password"
            value={userKey}
            onChange={(e) => setUserKey(e.target.value)}
            placeholder="Z.ai API key (optional)"
            autoComplete="off"
          />
          <Button onClick={saveKey}>Save</Button>
        </CardContent>
      </Card>

      <Separator />

      {/* About */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">How this works</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Local-first:</span> decks and study progress are stored in
            your browser. Use “Export backup” to move them between devices — there are no accounts.
          </p>
          <p>
            <span className="font-medium text-foreground">Generation:</span> your pasted/uploaded text is sent to a GLM
            model (free tier) which converts it into question/answer cards. Files are parsed in your browser; only the
            extracted text is sent. Cards are grounded in your source — the model is instructed never to add outside
            facts.
          </p>
          <p>
            <span className="font-medium text-foreground">Scheduling:</span> an SM-2 style algorithm (Anki-like) plans
            reviews; export any deck as TSV to keep studying in Anki.
          </p>
          <div className="flex gap-2 rounded-lg border border-amber-600/30 bg-amber-600/5 p-3 text-foreground">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <p className="text-xs">
              <span className="font-medium">Medical disclaimer:</span> AI-generated cards can contain errors even in
              precision mode. Always cross-check critical facts (doses, thresholds, criteria) against your official
              resources before an exam. This tool assists studying; it does not replace your curriculum or clinical
              judgment.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
