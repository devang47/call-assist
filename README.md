# Call-Assist

AI-powered phone assistant for dental offices. Takes incoming calls via Twilio, converses naturally with patients, and books appointments on Google Calendar.

## How It Works

```
Phone Call → Twilio → Deepgram Flux STT (streaming + turn detection) → Groq LLM → Deepgram TTS → Twilio → Caller
```

1. Patient calls the Twilio number
2. Twilio streams audio to the server via WebSocket
3. **Deepgram Flux** transcribes while the caller talks and decides when their turn is over (no fixed silence wait)
4. On a *likely* end of turn (`EagerEndOfTurn`), the LLM request starts speculatively; it's dropped if the caller keeps talking and spoken only once Flux confirms the turn
5. **Groq Qwen 3.8 27B** (reasoning off) streams a response through a clause-level sentence buffer, calling Google Calendar tools when needed
6. **Deepgram Aura-2 TTS** converts each clause to speech as it arrives
7. Audio streams back to the caller via Twilio; if the caller talks over it, playback stops (barge-in)

The original pipeline (local Silero VAD → Groq Whisper batch) is still available with `STT_PROVIDER=whisper`.

## Latency

Every caller turn logs a `turn_latency` event (end of caller speech → first audio byte sent to Twilio, broken down by stage) to `storage/call-logs/`. After some test calls:

```bash
pnpm latency:report            # p50 / p90 / p99 per stage, as a markdown table
```

Target: **< 1s p50, < 1.5s p90** end of speech → first audio. The old README figure (~530ms) was measured *after* the VAD's 650ms silence window, so it left out the biggest single wait; the new numbers include it.

<!-- Paste `pnpm latency:report` output here, Flux vs Whisper. -->

## Features

- Natural voice conversation with patients
- Appointment scheduling via Google Calendar (check availability, book, reschedule)
- Practice info queries (hours, address, services)
- Barge-in support (caller can interrupt the AI mid-response)
- Speculative LLM start on eager end-of-turn, side-effecting tools gated until the turn is confirmed
- Hinglish/Indian English support (`flux-general-multi` with `en,hi` language hints)
- Dental terminology boosting for accurate transcription (Flux keyterms)
- Per-turn latency logging + p50/p90 report; optional Langfuse tracing of every LLM call

## Prerequisites

- Node.js 18+
- [Twilio](https://www.twilio.com) account with a phone number
- [Groq](https://console.groq.com) API key
- [Deepgram](https://deepgram.com) API key
- [Google Cloud](https://console.cloud.google.com) project with Calendar API enabled
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) or ngrok for local development

## Setup

```bash
# Install dependencies
npm install

# Copy and fill in environment variables
cp .env.example .env

# Download Silero VAD model (if not present)
mkdir -p models
curl -sL -o models/silero_vad.onnx \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | Your Twilio phone number |
| `GROQ_API_KEY` | Groq API key (for STT + LLM) |
| `DEEPGRAM_API_KEY` | Deepgram API key (Flux STT + TTS) |
| `STT_PROVIDER` | `flux` (default) or `whisper` (Silero VAD + Groq Whisper) |
| `FLUX_EAGER_EOT_THRESHOLD` | Speculative LLM start threshold, `0` disables (default `0.5`) |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | Optional: trace LLM calls to Langfuse (`LANGFUSE_BASE_URL` for region) |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `SERVER_URL` | Public URL of your server (for OAuth callback) |

### Google Calendar

1. Create a Google Cloud project and enable the Calendar API
2. Create OAuth 2.0 credentials (Web application)
3. Add `{SERVER_URL}/api/auth/google/callback` as a redirect URI
4. Start the server and visit `/api/auth/google` to connect your calendar
5. If you have multiple practices, use `/api/practices/{practiceId}/auth/google` instead

### Twilio

Configure your Twilio phone number webhooks:
- **A call comes in**: `https://{your-domain}/twilio/incoming-call` (POST)
- **Call status changes**: `https://{your-domain}/twilio/call-status` (POST)

## Development

```bash
# Start the dev server (watches for changes)
npm run dev

# In another terminal, expose via Cloudflare Tunnel
npm run tunnel

# Or use ngrok
ngrok http 3000
```

## Project Structure

```
src/
  config/env.ts              # Environment variable validation (Zod)
  index.ts                   # Server entry point
  pipeline/
    flux-stt.ts              # Deepgram Flux — streaming STT + turn detection (default)
    vad.ts                   # Silero VAD — speech boundary detection (whisper mode)
    stt.ts                   # Groq Whisper — batch speech-to-text (whisper mode)
    llm.ts                   # Groq LLM — streaming response + tool calling
    tts.ts                   # Deepgram TTS — streaming text-to-speech
    sentence-buffer.ts       # Buffers LLM tokens into sentences for TTS
    types.ts                 # Pipeline state types
  voice/
    audio-proxy.ts           # Pipeline orchestrator — wires VAD/STT/LLM/TTS per call
    prompts.ts               # System prompt for the dental assistant persona
  scheduling/
    google-calendar.ts       # Google Calendar OAuth + API client
    availability.ts          # FreeBusy queries, slot computation
    booking.ts               # Create calendar events
  server/
    app.ts                   # Fastify app setup
    routes/twilio.ts         # Twilio webhook + WebSocket routes
    routes/calendar.ts       # Google OAuth flow
  lib/
    latency.ts               # Turn latency record + percentiles
    telemetry.ts             # Optional Langfuse / OpenTelemetry setup
scripts/                     # Provider benchmarks + latency-report.ts (real-call p50/p90)
models/
  silero_vad.onnx            # Silero VAD model (not checked into git)
```

## Benchmarks

Run latency benchmarks against individual services:

```bash
pnpm bench:stt:providers   # STT providers
pnpm bench:llm:providers   # LLM providers (TTFT, first sentence)
pnpm bench:tts:providers   # TTS providers (time to first byte)
pnpm bench:e2e             # Round trip with real audio (input.mp3)
```

## Tech Stack

| Component | Service | Latency |
|-----------|---------|---------|
| STT + turn detection | Deepgram Flux (`flux-general-multi`) | see `pnpm latency:report` |
| STT (fallback) | Silero VAD + Groq Whisper Large V3 Turbo | 650ms silence wait + ~315ms |
| LLM | Groq Qwen 3.8 27B | not yet measured (`pnpm bench:llm:providers`) |
| TTS | Deepgram Aura-2 | ~400ms first byte |
| Telephony | Twilio Media Streams | - |
| Scheduling | Google Calendar API | - |
| Tool Calling | Vercel AI SDK + Zod | - |
| Observability | Langfuse via OpenTelemetry (optional) | - |

## License

ISC
