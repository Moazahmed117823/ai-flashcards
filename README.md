# AI Flashcards

Free AI-powered flashcard maker built for **medical students** — paste your notes or dump a PDF and get precise, source-grounded question/answer decks. Study them with spaced repetition, export to Anki anytime.

Runs entirely on the **free tier** of the Z.ai GLM API (`glm-4.7-flash` costs $0) — no user accounts, no per-user API keys, no database server.

## Features

- **Source-grounded generation** — the model is instructed to use *only* facts from your material. No invented values.
- **File dumps** — PDF, DOCX, TXT and MD are parsed **in the browser**; only extracted text is sent for generation.
- **Precision mode** — an optional second AI pass re-verifies every card against the source and flags/corrects anything unsupported.
- **Auto-organization** — every deck is tagged with subject / system / topic / keywords as part of generation.
- **Spaced repetition** — SM-2 style scheduling (Again / Hard / Good / Easy) with due tracking and keyboard shortcuts.
- **Local-first storage** — decks live in your browser (IndexedDB). No accounts. JSON backup export/import.
- **Anki export** — one click per deck (TSV with tags).
- **Free-tier aware** — built-in serial request queue + batching, designed around the GLM Flash concurrency limits.
- **Optional BYOK** — visitors can paste their own free Z.ai key (stored in their browser) to skip the shared queue.

## How the free model setup works

The app calls `https://api.z.ai/api/paas/v4/chat/completions` with **one server-side API key** that you (the site owner) put in an environment variable. `glm-4.7-flash` is $0 for input and output, so the whole thing costs nothing. The only constraint is the free tier's ~1 concurrent request per key, which the built-in queue handles.

| Env variable | Required | Default | Purpose |
|---|---|---|---|
| `ZAI_API_KEY` | yes (production) | — | Your Z.ai platform API key (free) |
| `ZAI_MODEL` | no | `glm-4.7-flash` | Any GLM model id (e.g. `glm-4.5-flash`, `glm-5.3-flash`) |
| `ZAI_THINKING` | no | `disabled` | `enabled` trades speed for extra reasoning |

> No key in dev? The app falls back to the sandbox `z-ai-web-dev-sdk` when present, so you can still test the UI. Without any backend the generate endpoint returns a clear error.

## Run locally

```bash
bun install        # or npm install / pnpm install
cp .env.example .env.local   # add your ZAI_API_KEY
bun run dev        # http://localhost:3000
```

## Deploy

**Vercel** — import the repo, add `ZAI_API_KEY` in Project → Settings → Environment Variables, deploy. (Hobby plan serverless functions have a time limit; the route is configured for 60s max which is enough for typical decks.)

**Cloudflare Pages** — build command `npx @cloudflare/next-on-pages@1`, or use any Node host (the app is a standard Next.js App Router project).

After deploying:

1. Open the site → **Create** → paste notes or upload a file → Generate.
2. Review the cards (edit/delete anything the verifier flagged), save, and study.

## API routes

| Route | Purpose |
|---|---|
| `GET /api` | health + active backend + queue depth |
| `POST /api/generate` | `{ source, count, difficulty, language }` → deck meta + cards |
| `POST /api/verify` | `{ source, cards }` → per-card `ok / fixed / removed` verdicts |

Both routes serialize through a shared concurrency-1 queue and return `429` with `retryAfter` when saturated.

## Medical disclaimer

AI-generated cards can contain errors even in precision mode. Always cross-check critical facts (doses, thresholds, diagnostic criteria) against official resources. This tool assists studying; it does not replace your curriculum, your question banks, or clinical judgment.

## License

MIT
