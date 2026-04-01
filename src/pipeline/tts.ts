import WebSocket from "ws";
import { EventEmitter } from "events";
import { env } from "../config/env.js";

/**
 * Deepgram TTS streaming via raw WebSocket.
 * Opens a persistent connection for the duration of a call.
 * Accepts text chunks and emits base64 mulaw audio for Twilio.
 */
export class DeepgramTTS extends EventEmitter {
  private ws: WebSocket | null = null;
  private isOpen = false;
  private pendingText: string[] = [];

  async start(): Promise<void> {
    const params = new URLSearchParams({
      model: "aura-2-thalia-en",
      encoding: "mulaw",
      sample_rate: "8000",
    });

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`wss://api.deepgram.com/v1/speak?${params}`, {
        headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}` },
      });

      this.ws.on("open", () => {
        this.isOpen = true;
        this.emit("open");

        for (const text of this.pendingText) {
          this.sendText(text);
        }
        this.pendingText = [];

        resolve();
      });

      this.ws.on("message", (data, isBinary) => {
        if (isBinary) {
          // Binary frame = raw audio data
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          this.emit("audio", buf.toString("base64"));
        } else {
          // Text frame = JSON control message
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "Flushed") {
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
        this.isOpen = false;
        this.emit("close");
      });
    });
  }

  sendText(text: string): void {
    if (!text.trim()) return;

    if (!this.ws || !this.isOpen) {
      this.pendingText.push(text);
      return;
    }

    this.ws.send(JSON.stringify({ type: "Speak", text }));
  }

  flush(): void {
    if (this.ws && this.isOpen) {
      this.ws.send(JSON.stringify({ type: "Flush" }));
    }
  }

  clear(): void {
    if (this.ws && this.isOpen) {
      this.ws.send(JSON.stringify({ type: "Clear" }));
    }
    this.pendingText = [];
  }

  close(): void {
    if (this.ws) {
      if (this.isOpen) {
        this.ws.send(JSON.stringify({ type: "Close" }));
      }
      this.ws.close();
      this.ws = null;
    }
  }
}
