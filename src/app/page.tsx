'use client'

import { useCallback, useEffect, useState } from 'react'
import { GraduationCap, Layers, Moon, Plus, Settings, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import type { Deck, Draft } from '@/lib/types'
import { deleteDeck as removeDeck, getAllDecks, saveDeck } from '@/lib/storage'
import { Button } from '@/components/ui/button'
import { Dashboard } from '@/components/flashcards/Dashboard'
import { CreatePanel } from '@/components/flashcards/CreatePanel'
import { ReviewEditor } from '@/components/flashcards/ReviewEditor'
import { StudyPanel } from '@/components/flashcards/StudyPanel'
import { SettingsPanel } from '@/components/flashcards/SettingsPanel'
import { cn } from '@/lib/utils'

type View = 'decks' | 'create' | 'review' | 'study' | 'settings'

export default function Home() {
  const [view, setView] = useState<View>('decks')
  const [decks, setDecks] = useState<Deck[]>([])
  const [loading, setLoading] = useState(true)
  const [studyId, setStudyId] = useState<string | null>(null)
  const [browse, setBrowse] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)

  const refresh = useCallback(async () => {
    setDecks(await getAllDecks())
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const d = await getAllDecks()
      if (cancelled) return
      setDecks(d)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleDelete = useCallback(
    async (id: string) => {
      await removeDeck(id)
      await refresh()
      toast.success('Deck deleted.')
    },
    [refresh],
  )

  const handleDraft = useCallback((d: Draft) => {
    setDraft(d)
    setView('review')
  }, [])

  const handleSaveDeck = useCallback(
    async (deck: Deck) => {
      await saveDeck(deck)
      await refresh()
      setDraft(null)
      setView('decks')
      toast.success(`“${deck.title}” saved — ${deck.cards.length} cards.`)
    },
    [refresh],
  )

  const openStudy = useCallback((id: string, browseMode = false) => {
    setStudyId(id)
    setBrowse(browseMode)
    setView('study')
  }, [])

  const nav: Array<{ key: View; label: string; icon: React.ReactNode }> = [
    { key: 'decks', label: 'Decks', icon: <Layers className="h-4 w-4" /> },
    { key: 'create', label: 'Create', icon: <Plus className="h-4 w-4" /> },
    { key: 'study', label: 'Study', icon: <GraduationCap className="h-4 w-4" /> },
    { key: 'settings', label: 'Settings', icon: <Settings className="h-4 w-4" /> },
  ]

  return (
    <div className="flex min-h-screen flex-col">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <button
            className="flex items-center gap-2 font-semibold tracking-tight"
            onClick={() => setView('decks')}
            aria-label="AI Flashcards home"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <GraduationCap className="h-5 w-5" />
            </span>
            <span className="hidden sm:inline">AI Flashcards</span>
          </button>

          <nav className="flex flex-1 items-center justify-center gap-1" aria-label="Main navigation">
            {nav.map((n) => (
              <Button
                key={n.key}
                variant={view === n.key || (n.key === 'create' && view === 'review') ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => {
                  if (n.key === 'study' && studyId) {
                    setView('study')
                  } else {
                    setView(n.key)
                  }
                }}
                className="gap-1.5"
              >
                {n.icon}
                <span className="hidden xs:inline sm:inline">{n.label}</span>
              </Button>
            ))}
          </nav>

          <ThemeToggle />
        </div>
      </header>

      {/* Main */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        {loading ? (
          <div className="flex h-[50vh] items-center justify-center text-sm text-muted-foreground">
            Loading your decks…
          </div>
        ) : view === 'decks' ? (
          <Dashboard decks={decks} onCreate={() => setView('create')} onStudy={openStudy} onDelete={handleDelete} />
        ) : view === 'create' ? (
          <CreatePanel onDraft={handleDraft} />
        ) : view === 'review' && draft ? (
          <ReviewEditor draft={draft} onSave={handleSaveDeck} onCancel={() => { setDraft(null); setView('create') }} />
        ) : view === 'study' ? (
          <StudyPanel
            decks={decks}
            studyId={studyId}
            startInBrowse={browse}
            onExit={() => setView('decks')}
            onDeckChanged={refresh}
          />
        ) : (
          <SettingsPanel decks={decks} onChanged={refresh} />
        )}
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 py-4 text-center text-xs text-muted-foreground sm:flex-row sm:text-left">
          <p>
            AI Flashcards — notes in, exam-ready Q/A out. Runs on the free GLM Flash tier; your decks never leave this
            browser.
          </p>
          <p className="shrink-0">
            AI-generated content — verify critical facts against your curriculum.
          </p>
        </div>
      </footer>
    </div>
  )
}

function ThemeToggle() {
  const { setTheme } = useTheme()

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle theme"
      onClick={() => {
        const isDark = document.documentElement.classList.contains('dark')
        setTheme(isDark ? 'light' : 'dark')
      }}
    >
      <Sun className="h-4 w-4 dark:hidden" />
      <Moon className="hidden h-4 w-4 dark:block" />
    </Button>
  )
}
