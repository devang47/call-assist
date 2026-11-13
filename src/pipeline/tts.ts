import WebSocket from "ws";
import { EventEmitter } from "events";
import { env } from "../config/env.js";
import { getCachedAudio, setCachedAudio } from "./tts-cache.js";

interface Utterance {
  text: string;
  /** Pre-synthesized audio from disk; null means Deepgram synthesizes it. */
  cachedAudio: string[] | null;
  /** Store Deepgram's audio on disk when done (fixed phrases only). */
  cacheResult: boolean;
  chunks: string[];
}

/**
 * Deepgram TTS streaming via raw WebSocket, one connection per call.
 *
 * Every `speak()` is one utterance in a FIFO queue, so audio leaves in the order
 * it was queued even when some utterances come from the disk cache. Emits
 * "audio" (base64 mulaw) and one "flushed" per utterance when its audio is out.
 */
export class DeepgramTTS extends EventEmitter {
  private ws: WebSocket | null = null;
  private isOpen = false;
  private reconnecting = false;
  private closed = false;
  private queue: Utterance[] = [];
  /** True between sending Clear and Deepgram confirming it: drop stale audio. */
  private discarding = false;

  async start(): Promise<void> {
    if (this.isOpen) return; // Already connected (pre-warmed)
    if (this.ws) {
      // Connection in progress — wait for it
      return new Promise((resolve) => {
        this.once("open", resolve);
      });
    }
    return this.connect();
  }

  private connect(): Promise<void> {
    const params = new URLSearchParams({
      model: env.DEEPGRAM_TTS_MODEL,
      encoding: "mulaw",
      sample_rate: "8000",
    });

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`wss://api.deepgram.com/v1/speak?${params}`, {
        headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}` },
      });

      this.ws.on("open", () => {
        this.isOpen = true;
        this.reconnecting = false;
        this.discarding = false;
        // Send anything queued before the socket opened, or re-send utterances
        // that were in flight when the previous socket dropped.
        for (const item of this.queue) {
          if (item.cachedAudio) continue;
          item.chunks = [];
          this.sendSpeak(item.text);
        }
        this.emit("open");
        resolve();
      });

      this.ws.on("message", (data, isBinary) => {
        if (isBinary) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          this.handleAudio(buf.toString("base64"));
          return;
        }
        try {
          this.handleControl(JSON.parse(data.toString()));
        } catch {
          // ignore malformed control messages
        }
      });

      this.ws.on("error", (err) => {
        this.emit("error", err);
        if (!this.isOpen) reject(err);
      });

      this.ws.on("close", () => {
        const wasOpen = this.isOpen;
        this.isOpen = false;

        if (wasOpen && !this.reconnecting && !this.closed) {
          this.emit("disconnected");
          this.reconnect();
        }

        this.emit("close");
      });
    });
  }

  private handleAudio(b64: string): void {
    if (this.discarding) return;
    const head = this.queue[0];
    if (head && !head.cachedAudio && head.cacheResult) head.chunks.push(b64);
    this.emit("audio", b64);
  }

  private handleControl(msg: { type?: string }): void {
    if (msg.type === "Cleared") {
      this.discarding = false;
      return;
    }
    if (msg.type !== "Flushed" || this.discarding) return;

    const done = this.queue.shift();
    if (done?.cacheResult && done.chunks.length > 0) {
      setCachedAudio(done.text, done.chunks);
    }
    this.emit("flushed");
    this.drainCached();
  }

  /** Play cached utterances that have reached the front of the queue. */
  private drainCached(): void {
    while (this.queue[0]?.cachedAudio) {
      const item = this.queue.shift()!;
      for (const chunk of item.cachedAudio!) this.emit("audio", chunk);
      process.nextTick(() => this.emit("flushed"));
    }
  }

  private sendSpeak(text: string): void {
    this.ws!.send(JSON.stringify({ type: "Speak", text }));
    this.ws!.send(JSON.stringify({ type: "Flush" }));
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;

    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.connect();
        this.emit("reconnected", attempt);
        return;
      } catch {
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
    }

    this.reconnecting = false;
    this.emit("error", new Error("TTS reconnection failed after 3 attempts"));
  }

  /**
   * Queue one utterance. `cache: true` for fixed phrases (greeting, hold
   * messages, fallbacks) — never for LLM output, which can contain patient
   * names and phone numbers.
   */
  speak(text: string, opts: { cache?: boolean } = {}): void {
    if (!text.trim()) return;
    const cachedAudio = opts.cache ? getCachedAudio(text) : null;
    this.queue.push({ text, cachedAudio, cacheResult: Boolean(opts.cache), chunks: [] });

    if (cachedAudio) {
      this.drainCached();
      return;
    }
    if (this.ws && this.isOpen) this.sendSpeak(text);
    // else: sent from the "open" handler
  }

  /** Barge-in: drop everything queued or in flight. */
  clear(): void {
    this.queue = [];
    if (this.ws && this.isOpen) {
      this.ws.send(JSON.stringify({ type: "Clear" }));
      this.discarding = true;
    }
  }

  close(): void {
    this.closed = true; // Prevent reconnect on intentional close
    if (this.ws) {
      if (this.isOpen) {
        this.ws.send(JSON.stringify({ type: "Close" }));
      }
      this.ws.close();
      this.ws = null;
    }
    this.queue = [];
  }
}
