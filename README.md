# Call-Assist

AI-powered phone assistant for dental offices. Takes incoming calls via Twilio, converses naturally with patients, and books appointments on Google Calendar.

## How It Works

```
Phone Call → Twilio → Silero VAD → Groq Whisper STT → Groq LLM → Deepgram TTS → Twilio → Caller
```

1. Patient calls the Twilio number
2. Twilio streams audio to the server via WebSocket
3. **Silero VAD** (local) detects when the caller starts/stops speaking
4. **Groq Whisper** transcribes the buffered audio in ~315ms
5. **Groq Qwen 3.8 27B** (reasoning off) generates a response, streaming through a sentence buffer
6. **Deepgram TTS** converts each sentence to speech as it arrives
7. Audio streams back to the caller via Twilio

Perceived latency: **~530ms** from end of speech to first audio response.

## Features

- Natural voice conversation with patients
- Appointment scheduling via Google Calendar (check availability, book, reschedule)
- Practice info queries (hours, address, services)
- Barge-in support (caller can interrupt the AI mid-response)
- Hinglish/Indian English support
- Dental terminology boosting for accurate transcription

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
| `DEEPGRAM_API_KEY` | Deepgram API key (for TTS) |
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
    vad.ts                   # Silero VAD — speech boundary detection
    stt.ts                   # Groq Whisper — batch speech-to-text
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
scripts/                     # Latency benchmarks for STT, LLM, TTS, E2E
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
| VAD | Silero VAD (local) | ~30ms |
| STT | Groq Whisper Large V3 Turbo | ~315ms |
| LLM | Groq Qwen 3.8 27B | not yet measured (`pnpm bench:llm:providers`) |
| TTS | Deepgram Aura-2 | ~400ms first byte |
| Telephony | Twilio Media Streams | - |
| Scheduling | Google Calendar API | - |
| Tool Calling | Vercel AI SDK + Zod | - |

## License

ISC
