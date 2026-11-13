# Call-Assist

AI-powered phone receptionist for dental offices. Handles inbound calls via Twilio, schedules appointments on Google Calendar, and tracks patients — all through natural voice conversation.

## Tech Stack

- **Runtime**: Node.js / TypeScript with Fastify
- **Telephony**: Twilio (Media Streams WebSocket + REST API + SMS)
- **STT + turn detection**: Deepgram Flux (`flux-general-multi`, `/v2/listen` WebSocket, linear16 8kHz) — default, `STT_PROVIDER=flux`
- **Fallback STT** (`STT_PROVIDER=whisper`): Silero VAD via sherpa-onnx-node + Groq Whisper `whisper-large-v3-turbo` batch
- **LLM**: Groq `qwen/qwen3.8-27b` with `reasoning_effort: "none"` (streaming via Vercel AI SDK `@ai-sdk/openai` with Groq base URL)
- **TTS**: Deepgram Aura-2 (streaming WebSocket, mulaw 8kHz output)
- **Tool calling**: Vercel AI SDK (`ai` + `@ai-sdk/openai`) with Zod schemas, `stopWhen: stepCountIs(5)`
- **Observability**: per-turn `turn_latency` events in the call JSONL + `pnpm latency:report`; optional Langfuse (`@langfuse/otel`) via AI SDK `experimental_telemetry`
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
pnpm test         # vitest
pnpm latency:report [date]  # p50/p90/p99 per stage from storage/call-logs
```

## Architecture

### Voice Pipeline Flow

```
Twilio inbound call
  → POST /twilio/incoming-call (practice lookup by To number, create call log + patient)
  → TwiML <Stream> with <Parameter> elements (no <Say>; our cached greeting plays first)
  → WebSocket /twilio/media-stream
  → start event: read customParameters (practiceId, callerPhone, callLogId)
  → Load PracticeContext, pre-warm TTS, send greeting

Per-frame audio loop (flux, default):
  Twilio mulaw → linear16 → Deepgram Flux (80ms chunks, always streamed)
  → StartOfTurn: barge-in if speaking; warm Groq connection
  → EagerEndOfTurn: start a speculative LLM draft (not spoken, tools gated)
  → TurnResumed: cancel draft  → EndOfTurn: commit draft if transcript matches, else normal LLM turn
  → Groq LLM streaming with tools → Clause-level sentence buffer → Deepgram TTS → Twilio playback

Per-frame audio loop (whisper):
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
- **State machine**: `idle → listening → thinking → speaking`. Interruptions only allowed in `speaking` state. Tool execution happens in `thinking` (`onToolStart` drops back to it) — VAD events during this phase don't abort the response.
- **Eager end-of-turn drafts** (flux): `enqueueLLMTurn(transcript, ready)` runs `processLLMTurn` with a `ready: Promise<boolean>`. The LLM request goes out immediately but nothing is spoken or added to history until `ready` resolves true on `EndOfTurn`. Every tool `execute` first awaits the same promise (`gate` in `createTools`), so a draft can never book, transfer, or hang up. Flux guarantees `EndOfTurn` repeats the last `EagerEndOfTurn` transcript unless `TurnResumed` came between.
- **Turn latency**: `turn` holds timestamps for the turn being answered; the first TTS audio byte after it logs `turn_latency` (`TurnLatency` in `src/lib/latency.ts`). End of speech = VAD event minus `VAD_MIN_SILENCE_DURATION_S` (whisper) or Flux's last word end mapped to wall time via `fluxAudioStartAt` (flux). `call_latency_summary` is logged at cleanup.
- **Barge-in**: Flux `StartOfTurn` (flux) or VAD speech start (whisper) while `speaking` (`BARGE_IN_ENABLED`). On speech start, `interrupt()` sends Twilio `clear`, calls `tts.clear()`, aborts the LLM, and bumps `speechEpoch` so the running turn stops and saves only its partial text.
- **Conversation history**: After each turn, the AI SDK response messages (assistant tool calls + tool results) are appended, not just the spoken text, so the model remembers offered slots.
- **TTS queue + audio cache**: `tts.speak(text, { cache })` queues one utterance; audio is emitted in queue order even when an utterance comes from disk. Only fixed phrases (`cache: true`: greeting, hold messages, fallbacks) are cached, keyed by SHA-256 of model + text in `storage/tts-cache/`. LLM output is never cached (it can contain names/phone numbers).
- **Tool hold messages**: "Let me check that for you" / "One moment while I book that" sent via TTS before tool execution so caller isn't left in silence.
- **Contextual fallbacks**: When LLM returns empty text (tool calls consumed all steps), the system sends a contextual message based on call state (goodbye, booking confirmation, or retry prompt).
- **Speculative prefetch**: After STT, if transcript contains scheduling keywords ("appointment", "tomorrow", etc.), `check_availability` fires in parallel with the LLM call. Date is extracted from natural language. The tool checks a 30s TTL cache before hitting the Calendar API — saves 500-1500ms when the LLM does request availability. Booking attempts invalidate that day's cache, and `book_appointment` re-checks FreeBusy before inserting.
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
- **Garbage STT**: Whisper mode only — filtered before LLM (< 2 words, < 4 chars, mostly non-ASCII). Flux doesn't hallucinate on noise, so one-word answers like "yes" are kept.
- **Flux disconnect**: Reconnect up to 3 times; audio clock resets

## Project Structure

```
src/
  config/env.ts              # Zod env schema (all config)
  db/
    schema.ts                # Drizzle table definitions
    index.ts                 # SQLite connection (WAL mode)
    practice-context.ts      # PracticeContext interface + DB loaders + cache
    queries/                 # call-logs.ts, transcripts.ts, patients.ts
  lib/
    call-debug-log.ts        # Per-call JSONL event log (storage/call-logs/<date>/<callSid>.jsonl)
    latency.ts               # TurnLatency record + percentiles
    telemetry.ts             # Optional Langfuse span processor (OpenTelemetry)
    time.ts                  # Timezone-aware date helpers
  middleware/
    twilio-signature.ts      # Webhook signature validation (skips WebSocket GETs)
  pipeline/
    flux-stt.ts              # Deepgram Flux streaming STT + turn events (default)
    vad.ts                   # Silero VAD (sherpa-onnx-node) — whisper mode
    stt.ts                   # Groq Whisper batch STT (with retry) — whisper mode
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
  bench-*-providers.ts       # Per-stage provider benchmarks (STT, LLM, TTS)
  bench-groq-e2e.ts          # Round trip: real audio → STT → LLM → TTS (pnpm bench:e2e)
  latency-report.ts          # p50/p90/p99 from real calls' turn_latency events
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
- `STT_PROVIDER` — `flux` (default) or `whisper`; `FLUX_EAGER_EOT_THRESHOLD` — `0` disables speculative drafts
- `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` — enable Langfuse tracing (traces contain patient PII)
- `GROQ_LLM_MODEL` — default `qwen/qwen3.8-27b`; `GROQ_LLM_REASONING_EFFORT` — default `none` (use `low` for gpt-oss)
- Practice config env vars are fallbacks — DB is the primary source

## Important Gotchas

- TwiML is XML — any `&` in URLs must be `&amp;`. Use `<Parameter>` elements instead of query params for WebSocket metadata.
- Twilio Media Stream WebSocket connections don't carry `X-Twilio-Signature` — signature validation middleware skips GET requests.
- `streamText` from Vercel AI SDK defaults to `stepCountIs(1)` which means tool results aren't sent back to the model. Must set `stopWhen: stepCountIs(N)` where N >= 2.
- `llama-3.3-70b-versatile` was retired by Groq for non-enterprise accounts (Aug 2026).
- Qwen 3.x reasons by default — keep `GROQ_LLM_REASONING_EFFORT=none` or TTFT balloons. Groq rejects `reasoning_format: raw` with tools.
- Tests: `pnpm test` (vitest, `src/**/*.test.ts`).
- State must be `"thinking"` (not `"speaking"`) during tool execution to prevent VAD interruptions from aborting the response before text arrives.
- Flux `eager_eot_threshold` must be ≤ `eot_threshold` or Deepgram rejects the connection.
- `@langfuse/otel` 6.x needs `@opentelemetry/api` < 1.10 and `@opentelemetry/core` 2.x — pinned in package.json; don't bump them independently.
- `better-sqlite3` requires native build — run `pnpm rebuild better-sqlite3` if bindings are missing.
