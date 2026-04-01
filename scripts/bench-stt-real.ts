/**
 * Benchmark: Deepgram STT with real audio (input.mp3)
 * Converts MP3 → mulaw 8kHz (Twilio format), streams to Deepgram, measures latency
 */
import "dotenv/config";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import WebSocket from "ws";
import path from "path";

const API_KEY = process.env.DEEPGRAM_API_KEY!;
const INPUT_FILE = path.resolve(process.cwd(), "input.mp3");

async function main() {
  console.log("=== Deepgram STT Benchmark (Real Audio) ===\n");

  // Convert MP3 to raw mulaw 8kHz (same format Twilio sends)
  console.log("Converting input.mp3 → mulaw 8kHz...");
  const mulawPath = "/tmp/input_mulaw.raw";
  execSync(`ffmpeg -y -i "${INPUT_FILE}" -ar 8000 -ac 1 -f mulaw "${mulawPath}" 2>/dev/null`);
  const audioData = readFileSync(mulawPath);
  console.log(`Audio: ${audioData.length} bytes (${(audioData.length / 8000).toFixed(1)}s at 8kHz)\n`);

  // Connect to Deepgram STT
  const params = new URLSearchParams({
    model: "nova-3",
    encoding: "mulaw",
    sample_rate: "8000",
    channels: "1",
    punctuate: "true",
    smart_format: "true",
    interim_results: "true",
    endpointing: "300",
    vad_events: "true",
    utterance_end_ms: "1000",
  });

  const connStart = performance.now();
  const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
    headers: { Authorization: `Token ${API_KEY}` },
  });

  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => {
      console.log(`Connection time: ${(performance.now() - connStart).toFixed(0)}ms\n`);
      resolve();
    });
    ws.on("error", reject);
  });

  // Track events
  const events: { time: number; type: string; detail: string }[] = [];
  const streamStart = performance.now();
  let firstInterim: number | null = null;
  let firstFinal: number | null = null;
  let fullTranscript = "";

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    const elapsed = performance.now() - streamStart;

    if (msg.type === "Results") {
      const transcript = msg.channel?.alternatives?.[0]?.transcript || "";
      const isFinal = msg.is_final;
      const speechFinal = msg.speech_final;

      if (transcript.trim()) {
        if (!isFinal) {
          if (!firstInterim) firstInterim = elapsed;
          events.push({ time: elapsed, type: "interim", detail: transcript.trim() });
        } else {
          if (!firstFinal) firstFinal = elapsed;
          fullTranscript += (fullTranscript ? " " : "") + transcript.trim();
          events.push({ time: elapsed, type: "final", detail: transcript.trim() });
        }
      }

      if (speechFinal) {
        events.push({ time: elapsed, type: "speech_final", detail: "endpointing" });
      }
    }

    if (msg.type === "SpeechStarted") {
      events.push({ time: elapsed, type: "speech_started", detail: "" });
    }

    if (msg.type === "UtteranceEnd") {
      events.push({ time: elapsed, type: "utterance_end", detail: "" });
    }
  });

  // Stream audio in 20ms chunks (160 bytes at 8kHz mulaw) — simulates real-time Twilio
  const CHUNK_SIZE = 160; // 20ms at 8kHz
  const CHUNK_INTERVAL = 20; // ms

  console.log("Streaming audio in 20ms chunks (real-time)...\n");

  for (let offset = 0; offset < audioData.length; offset += CHUNK_SIZE) {
    const chunk = audioData.subarray(offset, offset + CHUNK_SIZE);
    ws.send(chunk);
    await sleep(CHUNK_INTERVAL);
  }

  // Signal end and wait for final results
  ws.send(JSON.stringify({ type: "Finalize" }));
  await sleep(3000);

  // Print results
  const totalTime = performance.now() - streamStart;

  console.log("--- Timeline ---");
  for (const e of events) {
    const tag = e.type.padEnd(16);
    console.log(`  ${e.time.toFixed(0).padStart(6)}ms  ${tag}  ${e.detail}`);
  }

  console.log("\n--- Summary ---");
  console.log(`  First interim transcript: ${firstInterim?.toFixed(0) ?? "N/A"}ms`);
  console.log(`  First final transcript:   ${firstFinal?.toFixed(0) ?? "N/A"}ms`);
  console.log(`  Total streaming time:     ${totalTime.toFixed(0)}ms`);
  console.log(`\n  Full transcript: "${fullTranscript}"`);

  ws.close();
  console.log("\n✓ STT benchmark complete");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch(console.error);
