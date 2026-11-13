import WebSocket from "ws";
import { EventEmitter } from "events";
import alawmulaw from "alawmulaw";
import { env } from "../config/env.js";
const { mulaw } = alawmulaw;

/** 80ms of 8kHz linear16 — Deepgram's recommended Flux chunk size. */
const CHUNK_BYTES = 1280;

export interface FluxTurnInfo {
  event: "StartOfTurn" | "Update" | "EagerEndOfTurn" | "TurnResumed" | "EndOfTurn";
  turn_index: number;
  transcript: string;
  /** Seconds of stream audio; Deepgram sometimes sends these as strings. */
  audio_window_end: number | string;
  words?: Array<{ word: string; end?: number | string }>;
  end_of_turn_confidence?: number | string;
  trigger?: string;
}

/**
 * Deepgram Flux streaming STT with built-in turn detection, one socket per call.
 * Replaces Silero VAD + Whisper batch: no silence wait, no upload round trip.
 *
 * Emits "turn" (FluxTurnInfo) for StartOfTurn / EagerEndOfTurn / TurnResumed /
 * EndOfTurn, and "error". Audio is converted mulaw → linear16 (the one encoding
 * every Flux doc agrees on) and sent in 80ms chunks.
 */
export class FluxSTT extends EventEmitter {
  private ws: WebSocket | null = null;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private closed = false;
  private retries = 0;

  start(): void {
    const params = new URLSearchParams({
      model: env.DEEPGRAM_STT_MODEL,
      encoding: "linear16",
      sample_rate: "8000",
      eot_threshold: String(env.FLUX_EOT_THRESHOLD),
      eot_timeout_ms: String(env.FLUX_EOT_TIMEOUT_MS),
    });
    if (env.FLUX_EAGER_EOT_THRESHOLD) {
      params.set("eager_eot_threshold", String(env.FLUX_EAGER_EOT_THRESHOLD));
    }
    if (env.DEEPGRAM_STT_MODEL === "flux-general-multi") {
      for (const lang of env.FLUX_LANGUAGE_HINTS) params.append("language_hint", lang);
    }
    for (const term of KEYTERMS) params.append("keyterm", term);

    const ws = new WebSocket(`wss://api.deepgram.com/v2/listen?${params}`, {
      headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}` },
    });
    this.ws = ws;

    ws.on("open", () => {
      this.retries = 0;
      this.emit("open");
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let msg: { type?: string } & Partial<FluxTurnInfo> & { description?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "TurnInfo" && msg.event !== "Update") {
        this.emit("turn", msg as FluxTurnInfo);
      } else if (msg.type === "Error") {
        this.emit("error", new Error(`Flux: ${msg.description ?? "unknown error"}`));
      }
    });
    ws.on("error", (err) => this.emit("error", err));
    ws.on("close", () => {
      if (this.ws !== ws || this.closed) return;
      // ponytail: reconnect restarts Flux's audio clock and turn_index; fine for latency math within a turn.
      if (this.retries++ < 3) {
        setTimeout(() => !this.closed && this.start(), 300 * this.retries);
        this.emit("reconnecting", this.retries);
      } else {
        this.emit("error", new Error("Flux STT reconnection failed after 3 attempts"));
      }
    });
  }

  /** One Twilio media frame (base64-decoded mulaw). Buffered until the socket opens. */
  sendMulaw(frame: Buffer): void {
    if (this.closed) return;
    const pcm = mulaw.decode(new Uint8Array(frame));
    this.pending.push(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    this.pendingBytes += pcm.byteLength;
    if (this.ws?.readyState !== WebSocket.OPEN) {
      // Don't grow forever if Deepgram is unreachable: keep the last ~5s.
      while (this.pendingBytes > 80_000) this.pendingBytes -= this.pending.shift()!.length;
      return;
    }
    if (this.pendingBytes < CHUNK_BYTES) return;
    this.ws.send(Buffer.concat(this.pending));
    this.pending = [];
    this.pendingBytes = 0;
  }

  close(): void {
    this.closed = true;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "CloseStream" }));
    }
    this.ws?.close();
    this.ws = null;
  }
}

/** Dental vocabulary Flux should prefer (Deepgram keyterm prompting). */
const KEYTERMS = [
  "appointment",
  "cleaning",
  "checkup",
  "root canal",
  "crown",
  "filling",
  "extraction",
  "whitening",
  "hygienist",
];

/** Numbers that Flux sometimes sends as strings. */
export function num(v: number | string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}
