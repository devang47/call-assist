# Call-Assist

AI-powered phone receptionist for dental offices. Handles inbound calls via Twilio, schedules appointments on Google Calendar, and tracks patients — all through natural voice conversation.

## Tech Stack

- **Runtime**: Node.js / TypeScript with Fastify
- **Telephony**: Twilio (Media Streams WebSocket + REST API + SMS)
- **VAD**: Silero VAD via sherpa-onnx-node (local, mulaw 8kHz → float32 16kHz)
- **STT**: Groq Whisper (`whisper-large-v3-turbo`, batch API, auto language detect)
- **LLM**: Groq `llama-3.3-70b-versatile` (streaming via Vercel AI SDK `@ai-sdk/openai` with Groq base URL)
- **TTS**: Deepgram Aura-2 (streaming WebSocket, mulaw 8kHz output)
- **Tool calling**: Vercel AI SDK (`ai` + `@ai-sdk/openai`) with Zod schemas, `stopWhen: stepCountIs(5)`
- **Database**: SQLite (better-sqlite3) + Drizzle ORM
- **Scheduling**: Google Calendar API (per-practice OAuth)

## Commands

```bash
pnpm dev          # Start dev server (tsx watch)
pnpm build        # TypeScript compile
pnpm start        # Run compiled JS
pnpm tunnel       # cloudflared tunnel for Twilio webhooks
pnpm db:generate  # Generate Drizzle migration
pnpm db:migrate   # Run migrations
pnpm db:seed      # Seed a practice from .env values
pnpm db:studio    # Drizzle Kit studio (DB browser)
```

## Architecture

### Voice Pipeline Flow

```
Twilio inbound call
  → POST /twilio/incoming-call (practice lookup by To number, create call log + patient)
  → TwiML <Say> + <Stream> with <Parameter> elements
  → WebSocket /twilio/media-stream
  → start event: read customParameters (practiceId, callerPhone, callLogId)
  → Load PracticeContext, pre-warm TTS, send greeting

Per-frame audio loop:
  Twilio mulaw audio → Silero VAD (local) → speech boundaries
  → Groq Whisper batch STT (with garbage filter: min 2 words, 4 chars)
  → Speculative prefetch (if scheduling keywords detected, fire check_availability in parallel)
  → LLM turn queue (prevents concurrent requests)
  → Groq LLM streaming with tools (check_availability uses prefetch cache if available)
  → Clause-level sentence buffer → Deepgram TTS → Twilio playback
```

### Key Design Patterns

- **PracticeContext**: Interface threaded through entire pipeline. Loaded from DB by Twilio number, falls back to env vars. All practice-specific config (name, hours, timezone, calendar, staff phone) comes from this, not env.
- **Twilio `<Parameter>` elements**: Custom metadata passed via TwiML `<Stream><Parameter>` tags, received in the WebSocket `start` event's `customParameters`. More reliable than URL query params.
- **LLM turn queue**: `enqueueLLMTurn()` → `runLLMTurn()`. If LLM is busy, new transcripts are merged and queued. Prevents stale-context concurrent requests.
- **State machine**: `idle → listening → thinking → speaking`. Interruptions only allowed in `speaking` state. Tool execution happens in `thinking` — VAD events during this phase don't abort the response.
- **TTS audio cache**: SHA-256 hash of text → mulaw chunks on disk (`storage/tts-cache/`). Greetings and common phrases served without API calls after first synthesis.
- **Tool hold messages**: "Let me check that for you" / "One moment while I book that" sent via TTS before tool execution so caller isn't left in silence.
- **Contextual fallbacks**: When LLM returns empty text (tool calls consumed all steps), the system sends a contextual message based on call state (goodbye, booking confirmation, or retry prompt).
- **Speculative prefetch**: After STT, if transcript contains scheduling keywords ("appointment", "tomorrow", etc.), `check_availability` fires in parallel with the LLM call. Date is extracted from natural language. The tool checks a 30s TTL cache before hitting the Calendar API — saves 500-1500ms when the LLM does request availability.
- **Clause-level sentence buffer**: Flushes TTS on clause boundaries (commas, semicolons, conjunctions like "and"/"but"), not just sentence-ending punctuation. Gets audio playing ~200ms earlier.

### Database (SQLite + Drizzle)

DB file: `data/call-assist.db`. Schema in `src/db/schema.ts`.

| Table | Purpose |
|---|---|
| `practices` | Practice config (name, hours, twilio_number, staff_phone, etc.) |
| `google_oauth_tokens` | Per-practice Google Calendar OAuth credentials |
| `call_logs` | One row per call (outcome, duration, cost) |
| `call_transcripts` | Per-turn transcript (user/assistant/tool with sequence) |
| `patients` | Repeat caller tracking by phone (call_count, name) |

Routing: `practices.twilio_number` → looked up in `/incoming-call` by `body.To`.

### LLM Tools

Defined in `src/pipeline/llm.ts` as a factory that closes over `PracticeContext`:

| Tool | Purpose |
|---|---|
| `check_availability` | Query Google Calendar FreeBusy for open slots |
| `book_appointment` | Create Google Calendar event (validates patient name) |
| `get_practice_info` | Return practice hours, address, services |
| `transfer_to_human` | Twilio REST API `<Dial>` to staff phone |
| `end_call` | Graceful hangup after goodbye |

On `tool_use_failed` (Groq malformed tool call), the system retries once without tools.

### Error Recovery

- **TTS disconnect**: Auto-reconnect with 3 retries (exponential backoff)
- **STT failure**: Retry once (300ms backoff), then fallback message
- **Empty LLM response**: Contextual fallback based on call state
- **tool_use_failed**: Retry without tools to get a plain text response
- **Garbage STT**: Filtered before LLM (< 2 words, < 4 chars, mostly non-ASCII)

## Project Structure

```
src/
  config/env.ts              # Zod env schema (all config)
  db/
    schema.ts                # Drizzle table definitions
    index.ts                 # SQLite connection (WAL mode)
    practice-context.ts      # PracticeContext interface + DB loaders + cache
    queries/                 # call-logs.ts, transcripts.ts, patients.ts
  middleware/
    twilio-signature.ts      # Webhook signature validation (skips WebSocket GETs)
  pipeline/
    vad.ts                   # Silero VAD (sherpa-onnx-node)
    stt.ts                   # Groq Whisper batch STT (with retry)
    llm.ts                   # Groq LLM + tool definitions + tool_use_failed retry
    tts.ts                   # Deepgram Aura-2 streaming TTS (with cache + reconnect)
    tts-cache.ts             # Disk-based TTS audio cache (SHA-256 → mulaw)
    sentence-buffer.ts       # Buffer LLM tokens into sentence chunks for TTS
    types.ts                 # PipelineState type
  scheduling/
    google-calendar.ts       # Per-practice OAuth client factory (cached)
    availability.ts          # FreeBusy query → available slots
    booking.ts               # Calendar event creation
  server/
    app.ts                   # Fastify setup (structured logging, plugins)
    routes/twilio.ts         # /incoming-call, /media-stream (WS), /call-status
    routes/calendar.ts       # /practices/:id/auth/google OAuth flow
  services/
    sms.ts                   # Twilio SMS booking confirmation (fire-and-forget)
  voice/
    audio-proxy.ts           # Main pipeline orchestrator (per-call state machine)
    prompts.ts               # System prompt (PracticeContext-driven, few-shot, Hinglish)
  types/                     # Type declarations for alawmulaw, sherpa-onnx-node
scripts/
  seed.ts                    # Seed a practice + Google OAuth token from .env
  debug-call.ts              # Fetch Twilio call logs + error notifications
  bench-*.ts                 # Latency benchmarks (STT, LLM, TTS, round-trip)
drizzle/                     # Generated migrations
storage/tts-cache/           # Cached TTS audio (gitignored)
data/                        # SQLite DB file (gitignored)
models/silero_vad.onnx       # VAD model file
```

## Environment Variables

See `.env.example`. Key ones:
- `DATABASE_PATH` — SQLite file path (default `./data/call-assist.db`)
- `TWILIO_SIGNATURE_VALIDATION` — `true`/`false` (set `false` for local dev)
- `NODE_ENV` — `development` (pino-pretty) or `production` (JSON logs)
- `GROQ_LLM_MODEL` — default `llama-3.3-70b-versatile`
- Practice config env vars are fallbacks — DB is the primary source

## Important Gotchas

- TwiML is XML — any `&` in URLs must be `&amp;`. Use `<Parameter>` elements instead of query params for WebSocket metadata.
- Twilio Media Stream WebSocket connections don't carry `X-Twilio-Signature` — signature validation middleware skips GET requests.
- `streamText` from Vercel AI SDK defaults to `stepCountIs(1)` which means tool results aren't sent back to the model. Must set `stopWhen: stepCountIs(N)` where N >= 2.
- Groq's `openai/gpt-oss-20b` does NOT work with tool calling via the OpenAI-compatible endpoint. Use `llama-3.3-70b-versatile`.
- State must be `"thinking"` (not `"speaking"`) during tool execution to prevent VAD interruptions from aborting the response before text arrives.
- `better-sqlite3` requires native build — run `pnpm rebuild better-sqlite3` if bindings are missing.
