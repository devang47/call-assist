import Groq from "groq-sdk";
import { env } from "../config/env.js";

const SAMPLE_RATE = 8000;
const MIN_DURATION_S = 0.5;
const DENTAL_PROMPT =
  "periodontal endodontic orthodontic prophylaxis scaling root canal crown veneer implant extraction filling cavity gingivitis fluoride bruxism malocclusion dental hygienist cleaning checkup appointment schedule";

/**
 * Groq Whisper batch STT.
 * Buffers raw mulaw 8kHz audio, transcribes on demand via Groq API.
 */
export class GroqSTT {
  private groq: Groq;
  private audioChunks: Buffer[] = [];
  private totalBytes = 0;

  constructor() {
    this.groq = new Groq({ apiKey: env.GROQ_API_KEY });
  }

  appendAudio(chunk: Buffer): void {
    this.audioChunks.push(chunk);
    this.totalBytes += chunk.length;
  }

  getBufferDuration(): number {
    return this.totalBytes / SAMPLE_RATE;
  }

  async transcribe(): Promise<string> {
    if (this.getBufferDuration() < MIN_DURATION_S) {
      this.clearBuffer();
      return "";
    }

    const rawAudio = Buffer.concat(this.audioChunks);
    this.clearBuffer();

    const wavBuffer = createMulawWav(rawAudio, SAMPLE_RATE);
    const file = new File([new Uint8Array(wavBuffer)], "audio.wav", { type: "audio/wav" });

    const transcription = await this.groq.audio.transcriptions.create({
      file,
      model: env.GROQ_STT_MODEL,
      language: "en",
      prompt: DENTAL_PROMPT,
    });

    return transcription.text?.trim() || "";
  }

  clearBuffer(): void {
    this.audioChunks = [];
    this.totalBytes = 0;
  }
}

/** Create a WAV file with mulaw encoding header (44 bytes + raw data) */
function createMulawWav(rawData: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const dataSize = rawData.length;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(7, 20); // mulaw
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, rawData]);
}
