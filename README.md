# Picturebook Studio

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/Node.js-%E2%89%A5%2022-green)
![pnpm](https://img.shields.io/badge/pnpm-%E2%89%A5%209-orange)

**English** · [中文](README.zh.md)

Turn a one-line idea into a narrated picture-book video: an LLM writes the story, a text-to-image model paints the illustrations, PixiJS renders per-page animation frame-by-frame, TTS voices the narration with per-character dubbing, and ffmpeg mixes everything into an H.264 MP4. Live browser preview, per-page regeneration, voice configuration, one-click export.

The product ships **two independent pipelines** (switchable from the web home page):

1. **Picturebook Studio** (`/`) — for young children's picture books. Canvas-rendered illustration animation is the only clip source, guaranteeing the video matches the illustrations 100%.
2. **Story Video Studio** (`/project/create`) — for general story videos. Article → AI script analysis (episodes, scenes, character sheets, location cards) → **manual checkpoint: pick one of three portraits per character and one of three scene images per location** → **storyboard workbench (manual: generate each scene's video with reference-image-to-video, confirm one by one)** → fully AI-generated final cut.

There is no demo/mock mode: the product always calls real AI providers (it fails fast at startup if a key is missing).

## Features

- **Per-character dubbing** — the story carries `segments: [{speaker, text}]`; narrator lines use the narrator voice, character lines use a voice picked per character from a curated child-friendly voice palette, with automatic loudness normalization between voices
- **Voice review checkpoint** — after the script is finalized the pipeline pauses so you can audition and reassign the narrator and character voices before any illustration or TTS cost is spent
- **Illustration-faithful animation** — every clip is rendered headlessly by the same PixiJS code that drives the browser preview ("preview is the export")
- **Sound design** — AI analyzes each page and attaches plot sound effects (33 types) at precise moments, plus ambient beds (rain/snow/wind) derived from scene mood
- **Background music** — a built-in piano canon is mixed under the narration by default; can be toggled off per book at creation time
- **Robust export** — uniform crossfade joins between pages, per-input normalization so mixed-resolution clips join cleanly, narration-aware page durations with frozen last frame when speech runs long
- **16:9 and 9:16** — landscape or portrait aspect per book
- **Resumable pipeline** — persisted state machine; failed stages retry without redoing finished work
- **Zero-network test suite** — 379 unit/integration tests run fully offline with fake providers and recorded fixtures; Playwright e2e runs the whole product against deterministic stubs

## How it works

```
one-line theme / full article
        │
        ▼
  story_generating ──► story_moderating ──► ⏸ voice_review ──► pages_generating ──► ready ──► exporting ──► completed
   LLM writes Story     content safety        (manual)           per-page text-to-      preview,     concat clips with
   JSON (pages,         check + retry         audition &         image + PixiJS         export       crossfade, mix
   segments, sfx,       (≤3 attempts)         reassign           clip + per-page                       narration + SFX + BGM
   cover, characters)                         narrator/character TTS
                                             voices)
```

- Story page count is chosen by the AI from content volume (3–30); the last page is always a gentle "core idea" scene.
- A title card (cover) is generated in parallel and prepended to the film; its narration reads the book title with the configured narrator voice.
- Image generation failures fall back through seed retries and a softened prompt; a page that still fails becomes a placeholder and can be repainted individually — one bad page never blocks the book.
- Narration TTS failures skip that page's voice instead of blocking the export.

## Requirements

| Dependency | Version | Used for |
|---|---|---|
| Node.js | ≥ 22 | Runtime (native `process.loadEnvFile`, `fetch`) |
| pnpm | ≥ 9 | Workspace package manager |
| ffmpeg / ffprobe | ≥ 7 | Clip muxing and final export |
| Playwright Chromium | 1.49 | Headless clip rendering and e2e (`pnpm --filter @pb/web exec playwright install chromium`) |

You also need API keys for four provider capabilities (they may point at different vendors or a single gateway):

| Capability | Env prefix | Protocols | Default endpoint / model |
|---|---|---|---|
| Text (story + script analysis) | `TEXT` | `openai` (OpenAI-compatible `/chat/completions`) | DeepSeek / `deepseek-chat` |
| Text-to-image | `IMAGE` | `dashscope` / `openai` (`/images/generations`) | Alibaba Bailian / `qwen-image-2.0` |
| AI video (Story Video Studio only) | `VIDEO` | `dashscope` (r2v reference-to-video) / `newapi` / `openai` (Sora) | Bailian / `wan2.7-r2v` |
| Narration TTS | `TTS` | `dashscope` (Qwen-TTS; extra `TTS_VOICE` / `TTS_INSTRUCTIONS`) | Bailian / `qwen3-tts-instruct-flash` |

All four `*_API_KEY` values are required (fail-fast at startup). Pointing everything at one gateway is fine — just repeat the same key.

## Quick start

```bash
pnpm install
cp .env.example .env   # fill in the four API keys
```

```bash
# terminal 1 — backend API (port 8787, artifacts under apps/server/data/)
pnpm --filter @pb/server start

# terminal 2 — frontend (port 5173)
pnpm --filter @pb/web dev
```

Open **http://localhost:5173**:

1. Type a theme (e.g. "a child who is afraid of the dark") and optionally a book title, style, language, aspect ratio, and the background-music toggle — then hit **Start**.
2. The progress page streams state over SSE.
3. When the script is ready the pipeline **pauses at voice review**: audition the narrator and each character's voice (pre-generated demos included), reassign anything you don't like, then confirm.
4. Illustrations and narration are generated; the preview page plays the book, lets you repaint a page, or edit a page's narration (which re-dubs and re-renders only that page).
5. Click **Export** — the finished MP4 plays in-page and downloads.

## Configuration reference

| Variable | Default | Description |
|---|---|---|
| `PB_PROVIDERS` | — | `fake` is reserved for Playwright e2e stubs; production always uses real providers |
| `PORT` | `8787` | Backend port |
| `DATA_DIR` | `data` | Artifact directory (relative to server cwd) |
| `PB_PAGE_SIZE` | `1920x1080` | Landscape render size (lower it to speed up pipeline validation) |
| `PB_EXPORT_FPS` | `30` | Clip frame rate |
| `PB_EXPORT_TRANSITION_MS` | `600` | Crossfade between pages; `0` = hard cut |
| `PB_BGM` | built-in piano canon | Global BGM file; `off` disables (per-book toggle on the create page wins over this) |
| `PB_SFX` | on | Sound-effect layer; `off` disables both plot cues and ambient beds |
| `PB_VOICE_REVIEW` | on | Pause at `voice_review` for manual voice confirmation; `off` auto-proceeds (batch/automation) |
| `PB_DEFAULT_PAGE_COUNT` | — | Force page count (3–30, mainly for e2e); by default the AI decides from content volume |
| `PB_ASSET_ORIGIN` | `http://127.0.0.1:<PORT>` | Origin headless rendering uses to fetch assets |
| `PB_HARNESS_PAGES` | `3` | Browser-page pool size for parallel clip rendering (one WebGL context per page) |
| `TEXT_*` / `IMAGE_*` / `VIDEO_*` / `TTS_*` | see Quick start | Per-capability provider config: `_API` / `_BASE_URL` / `_API_KEY` / `_MODEL` |

## HTTP API

All endpoints are served by the backend (in dev, Vite proxies `/api` and `/assets`).

### Picturebook pipeline

| Method / path | Description |
|---|---|
| POST `/api/books` | Create a book and start the pipeline. Body: `theme` (required, 1–10000 chars), `title?`, `style?`, `lang?` (`zh\|en`), `format?` (`landscape\|portrait`), `page_count?` (3–30), `enhance?`, `bgm?` (default true). `201 {book_id}` |
| GET `/api/books/:id` | Status + progress; when ready also `preview.book_specs`, `exports`, `clips`; when paused at `voice_review` also `voice_review.characters` / `narrator_voice` |
| GET `/api/books/:id/events` | SSE stream: `state`, `progress`, `completed`, `failed`, `page_clip`, `page_narration` |
| GET `/api/books/:id/characters` | Voice review checkpoint: character list + narrator voice + voice palette (only in `voice_review`) |
| PUT `/api/books/:id/characters` | Reassign voices: `{voices: {"<name>": "<voice>" \| null, "旁白": "<voice>"}}` (key `旁白` = narrator; `null` = provider default) |
| POST `/api/books/:id/confirm-voices` | Leave `voice_review` and resume into illustration + narration generation. `202` |
| POST `/api/books/:id/pages/:pageId/regenerate` | Repaint one page (`ready` only, ≤3 per page; `title` regenerates the cover). `202 {remaining}` |
| PUT `/api/books/:id/pages/:pageId/text` | Edit narration text (`{narration}`) or cover text (`{cover:{title,subtitle?,tags?}}` for `pageId=title`); re-dubs and re-renders only that page. `202` |
| POST `/api/books/:id/export` | Join page clips into the final MP4 (`ready` only). `202 {state:"exporting"}` |
| POST `/api/books/:id/resume` | Recover from `failed_*` without redoing completed artifacts. `202` |
| GET `/assets/*` | Static artifacts: illustrations, clips, BookSpec JSON, exported MP4 |

State machine:

```
created → story_generating → story_moderating → voice_review → pages_generating
        → enhance_generating → ready → exporting → completed
failure: failed_{stage} (after ≤3 retries; POST /resume returns to the stage)
export failure: back to ready (idempotent, re-export allowed)
```

### Story Video pipeline

| Method / path | Description |
|---|---|
| POST `/api/projects` | `{source (1–10000), title?, style?, format?, lang?, episode_count? (1–3)}` → `201 {project_id}` |
| GET `/api/projects/:id` | Status + characters (portrait variants), locations, scenes, script, export |
| GET `/api/projects/:id/events` | SSE: `state` / `progress` / `portrait` / `location` / `scene_clip` / `scene_narration` |
| PUT `/api/projects/:id/characters/:charId/select` | Pick a portrait variant (manual checkpoint only) |
| POST `/api/projects/:id/characters/:charId/regenerate` | Rewrite description → 3 new variants (≤3 rounds) |
| PUT `/api/projects/:id/locations/:locId/select` · POST `.../regenerate` | Same for location scene cards |
| POST `/api/projects/:id/characters/confirm` | Release the checkpoint into the storyboard workbench |
| POST `/api/projects/:id/scenes/:sceneId/clip` | Generate one scene's video (r2v from selected references + auto dubbing) |
| POST `/api/projects/:id/scenes/:sceneId/regenerate` | Redo one scene (unlimited attempts) |
| POST `/api/projects/:id/export` · POST `/api/projects/:id/resume` | Export final cut / recover from failure |

Consistency guarantee: selected portraits and location images are fed directly as `reference_image` media to the r2v model (image 1 = scene, images 2..N = characters), with the prompt's `图N` numbering kept in lockstep with the media array.

## Repository layout

```
packages/
  renderer/   @pb/renderer  PixiJS v8 engine: SceneSpec/BookSpec schemas, motion presets,
              BookPlayer preview, offline renderFrames, headless harness
  ai-core/    @pb/ai-core   Provider interfaces + fake implementations (tests only) + real
              adapters (OpenAI-compatible text, DashScope image/video/TTS), story & script
              schemas, voice palette, wav utilities
apps/
  server/     @pb/server    Fastify: two state-machine pipelines, serial queues, SSE, REST,
              headless clip rendering, per-page TTS, ffmpeg mixing/export; shared clip-join
              core and run-pool used by both pipelines
  web/        @pb/web       React 18 + Vite: creation form, SSE progress, PixiJS preview,
              voice review, per-page playback, export download; Story Video workbench
```

## Design decisions

- **Preview is the export** — browser preview and final video consume the same BookSpec and the same renderer code.
- **Providers are swappable** — pipelines depend only on a `ProviderBundle` interface; tests inject fakes with zero production-code changes.
- **Illustration animation, not image-to-video, for picturebooks** — early experiments feeding illustrations into video models drifted visually from the artwork; the picturebook pipeline therefore renders clips deterministically from the illustrations themselves. Image-to-video lives exclusively in the Story Video pipeline.
- **Manual checkpoints are first-class states** — `voice_review` (picturebooks) and `awaiting_character_confirmation` / `storyboard_review` (story videos) pause the state machine until a human confirms, because each downstream step costs real API money.
- **Duration truth is the clip frame count** — final duration = Σ max(clip, narration); never derived from nominal `duration_ms`, which prevents audio/video drift.
- **Two pipelines, not one generalized pipeline** — the story-video line has its own state machine and repo; only genuinely shared code (clip joining, run pool, generic event hub) is factored down, keeping the picturebook line regression-free.

## Development

```bash
pnpm test          # 377 unit/integration tests across 4 packages (zero network)
pnpm typecheck     # TypeScript, all packages
pnpm --filter @pb/web test:e2e   # full-product Playwright e2e (own ports 8788/5174)
```

Real-provider behavior is pinned with fixtures and injected `fetch`; the e2e suite boots the whole app with `PB_PROVIDERS=fake`.

Regenerate bundled assets (all committed; only needed when the palette changes):

```bash
pnpm --filter @pb/server exec tsx scripts/gen-voice-demos.ts        # voice audition wavs
ELEVENLABS_API_KEY=*** pnpm --filter @pb/server exec tsx scripts/gen-sfx-elevenlabs.ts  # 33 SFX wavs
```

(The piano-canon BGM is synthesized on demand by `apps/server/src/export/bgm.ts` and cached under `<DATA_DIR>/bgm/` — no script needed.)

## Troubleshooting

- **`missing required env` at startup** — fill the four `*_API_KEY`s in `.env`; fail-fast is intentional.
- **`ffmpeg exit …` on export** — ensure ffmpeg ≥ 7 is on `PATH`; the error tail carries stderr.
- **Silent pages in the export** — narration is synthesized during the video stage; a page whose TTS failed (marked `!` in the thumbnail strip) exports without voice. Re-run the stage to retry.
- **Slow generation / high CPU** — page images run at concurrency 10; clips render with `PB_HARNESS_PAGES` browser pages; drop to `PB_PAGE_SIZE=320x180` for fast end-to-end validation.
- **PixiJS must not re-initialize on the same canvas** — it deadlocks the WebGL context; all rebuild paths in this repo already avoid it, keep it that way.

## Contributing

Contributions are welcome. Open an issue first for anything non-trivial so we can agree on scope. Keep `pnpm test` and `pnpm typecheck` green; follow the existing comment style (Chinese comments are the norm in this codebase).

## License

Licensed under the [Apache License, Version 2.0](LICENSE).

## Acknowledgements

Built on [PixiJS v8](https://pixijs.com), [Fastify](https://fastify.dev), [React](https://react.dev), [Vite](https://vite.dev), [Zod](https://zod.dev), and [Playwright](https://playwright.dev). AI capabilities exercised through DeepSeek, Alibaba Model Studio (Bailian: Qwen text/image/video/TTS), and ElevenLabs (sound-effect assets). The default BGM is an original offline synthesis of Pachelbel's Canon in D (public domain composition).
