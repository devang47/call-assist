import WebSocket from "ws";
import { EventEmitter } from "events";
import { env } from "../config/env.js";
import { getCachedAudio, setCachedAudio } from "./tts-cache.js";

/**
 * Deepgram TTS streaming via raw WebSocket.
 * Opens a persistent connection for the duration of a call.
 * Accepts text chunks and emits base64 mulaw audio for Twilio.
 *
 * Caches audio output by text hash — repeated phrases (greetings, error messages)
 * are served from disk without hitting the Deepgram API.
 */
export class DeepgramTTS extends EventEmitter {
  private ws: WebSocket | null = null;
  private isOpen = false;
  private pendingText: string[] = [];
  private pendingFlushes = 0;
  private reconnecting = false;

  // Cache collection: track chunks per text being synthesized
  private currentSynthText: string | null = null;
  private currentChunks: string[] = [];
  private lastWasCached = false;

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
        this.emit("open");

        for (const text of this.pendingText) {
          this.sendText(text);
        }
        this.pendingText = [];

        while (this.pendingFlushes > 0 && this.ws && this.isOpen) {
          this.ws.send(JSON.stringify({ type: "Flush" }));
          this.pendingFlushes--;
        }

        resolve();
      });

      this.ws.on("message", (data, isBinary) => {
        if (isBinary) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          const b64 = buf.toString("base64");

          // Collect chunks for caching
          if (this.currentSynthText) {
            this.currentChunks.push(b64);
          }

          this.emit("audio", b64);
        } else {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "Flushed") {
              // Cache the completed audio
              if (this.currentSynthText && this.currentChunks.length > 0) {
                setCachedAudio(this.currentSynthText, this.currentChunks);
              }
              this.currentSynthText = null;
              this.currentChunks = [];

              this.emit("flushed");
            }
          } catch {
            // ignore
          }
        }
      });

      this.ws.on("error", (err) => {
        this.emit("error", err);
        if (!this.isOpen) reject(err);
      });

      this.ws.on("close", () => {
        const wasOpen = this.isOpen;
        this.isOpen = false;

        if (wasOpen && !this.reconnecting) {
          // Unexpected disconnect — try to reconnect
          this.emit("disconnected");
          this.reconnect();
        }

        this.emit("close");
      });
    });
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;

    // Reset cache state for in-flight synthesis
    this.currentSynthText = null;
    this.currentChunks = [];

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

  sendText(text: string): void {
    if (!text.trim()) return;

    // Check cache first
    const cached = getCachedAudio(text);
    if (cached) {
      // Emit cached audio chunks directly — skip Deepgram entirely
      for (const chunk of cached) {
        this.emit("audio", chunk);
      }
      this.lastWasCached = true;
      return;
    }

    this.lastWasCached = false;

    // Track this text for caching when audio completes
    this.currentSynthText = text;
    this.currentChunks = [];

    if (!this.ws || !this.isOpen) {
      this.pendingText.push(text);
      return;
    }

    this.ws.send(JSON.stringify({ type: "Speak", text }));
  }

  flush(): void {
    if (this.lastWasCached) {
      // Audio already emitted from cache — just signal flushed
      this.lastWasCached = false;
      process.nextTick(() => this.emit("flushed"));
      return;
    }
    if (this.ws && this.isOpen) {
      this.ws.send(JSON.stringify({ type: "Flush" }));
      return;
    }
    this.pendingFlushes++;
  }

  clear(): void {
    if (this.ws && this.isOpen) {
      this.ws.send(JSON.stringify({ type: "Clear" }));
    }
    this.pendingText = [];
    this.pendingFlushes = 0;
    this.currentSynthText = null;
    this.currentChunks = [];
  }

  close(): void {
    this.reconnecting = true; // Prevent reconnect on intentional close
    if (this.ws) {
      if (this.isOpen) {
        this.ws.send(JSON.stringify({ type: "Close" }));
      }
      this.ws.close();
      this.ws = null;
    }
    this.pendingFlushes = 0;
  }
}
