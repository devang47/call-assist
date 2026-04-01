/**
 * Benchmark: Full round-trip — STT (real audio) → LLM → TTS → audio output
 * Simulates the actual call experience end-to-end
 */
import "dotenv/config";
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import WebSocket from "ws";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { streamText } from "ai";
import path from "path";

const DG_KEY = process.env.DEEPGRAM_API_KEY!;
const INPUT_FILE = path.resolve(process.cwd(), "input.mp3");

const openrouter = createOpenRouter({ apiKey: process.env.MIMO_API_KEY! });
const MODEL = process.env.MIMO_MODEL || "xiaomi/mimo-v2-flash";

async function main() {
  console.log("=== Full Round-Trip Benchmark ===");
  console.log(`STT: Deepgram Nova-3 | LLM: ${MODEL} | TTS: Deepgram Aura-2\n`);

  // --- Step 0: Convert audio ---
  const mulawPath = "/tmp/input_mulaw.raw";
  execSync(`ffmpeg -y -i "${INPUT_FILE}" -ar 8000 -ac 1 -f mulaw "${mulawPath}" 2>/dev/null`);
  const audioData = readFileSync(mulawPath);
  console.log(`Input audio: ${(audioData.length / 8000).toFixed(1)}s\n`);

  // --- Step 1: STT ---
  console.log("--- Phase 1: Speech-to-Text ---");
  const sttStart = performance.now();

  const sttParams = new URLSearchParams({
    model: "nova-3", encoding: "mulaw", sample_rate: "8000", channels: "1",
    punctuate: "true", smart_format: "true", interim_results: "true",
    endpointing: "300", vad_events: "true", utterance_end_ms: "1000",
  });

  const sttWs = new WebSocket(`wss://api.deepgram.com/v1/listen?${sttParams}`, {
    headers: { Authorization: `Token ${DG_KEY}` },
  });

  const transcript = await new Promise<string>((resolve, reject) => {
    let fullText = "";
    let done = false;

    sttWs.on("open", async () => {
      console.log(`  STT connected: ${(performance.now() - sttStart).toFixed(0)}ms`);

      // Stream audio real-time
      for (let offset = 0; offset < audioData.length; offset += 160) {
        sttWs.send(audioData.subarray(offset, offset + 160));
        await sleep(20);
      }
      sttWs.send(JSON.stringify({ type: "Finalize" }));
    });

    sttWs.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "Results" && msg.is_final) {
        const t = msg.channel?.alternatives?.[0]?.transcript || "";
        if (t.trim()) fullText += (fullText ? " " : "") + t.trim();
      }
      if (msg.type === "UtteranceEnd" && fullText && !done) {
        done = true;
        resolve(fullText);
      }
    });

    sttWs.on("error", reject);

    // Timeout — resolve with whatever we have
    setTimeout(() => { if (!done) { done = true; resolve(fullText); } }, 15000);
  });

  const sttTime = performance.now() - sttStart;
  sttWs.close();
  console.log(`  STT total:     ${sttTime.toFixed(0)}ms`);
  console.log(`  Transcript:    "${transcript}"\n`);

  if (!transcript) {
    console.log("No transcript — cannot continue.\n");
    return;
  }

  // --- Step 2: LLM ---
  console.log("--- Phase 2: LLM Response ---");
  const llmStart = performance.now();
  let llmTTFT: number | null = null;
  let firstSentenceTime: number | null = null;
  let sentenceBuffer = "";
  const sentences: string[] = [];
  let fullResponse = "";

  const result = streamText({
    model: openrouter.chat(MODEL),
    system: "You are a dental office receptionist. Keep responses brief and natural for a phone call. Respond with only spoken words, no markdown.",
    messages: [
      { role: "assistant", content: "Thank you for calling Smile Dental Clinic. How can I help you today?" },
      { role: "user", content: transcript },
    ],
    maxOutputTokens: 256,
    temperature: 0.7,
  });

  for await (const delta of result.textStream) {
    if (!llmTTFT) llmTTFT = performance.now() - llmStart;
    fullResponse += delta;
    sentenceBuffer += delta;

    if (/[.!?]$/.test(sentenceBuffer.trim()) && sentenceBuffer.trim().length > 10) {
      if (!firstSentenceTime) firstSentenceTime = performance.now() - llmStart;
      sentences.push(sentenceBuffer.trim());
      sentenceBuffer = "";
    }
  }
  if (sentenceBuffer.trim()) {
    if (!firstSentenceTime) firstSentenceTime = performance.now() - llmStart;
    sentences.push(sentenceBuffer.trim());
  }

  const llmTotal = performance.now() - llmStart;
  console.log(`  LLM TTFT:          ${llmTTFT?.toFixed(0) ?? "N/A"}ms`);
  console.log(`  First sentence:    ${firstSentenceTime?.toFixed(0) ?? "N/A"}ms`);
  console.log(`  LLM total:         ${llmTotal.toFixed(0)}ms`);
  console.log(`  Response:          "${fullResponse.slice(0, 100)}${fullResponse.length > 100 ? "..." : ""}"`);
  console.log(`  Sentences:         ${sentences.length}\n`);

  // --- Step 3: TTS ---
  console.log("--- Phase 3: Text-to-Speech ---");
  const ttsStart = performance.now();

  const ttsParams = new URLSearchParams({
    model: "aura-2-thalia-en", encoding: "mulaw", sample_rate: "8000",
  });

  const ttsWs = new WebSocket(`wss://api.deepgram.com/v1/speak?${ttsParams}`, {
    headers: { Authorization: `Token ${DG_KEY}` },
  });

  const ttsResult = await new Promise<{ firstByte: number; totalBytes: number; total: number }>((resolve, reject) => {
    let firstByte: number | null = null;
    let totalBytes = 0;
    let flushed = false;

    ttsWs.on("open", () => {
      console.log(`  TTS connected: ${(performance.now() - ttsStart).toFixed(0)}ms`);
      // Send first sentence immediately
      ttsWs.send(JSON.stringify({ type: "Speak", text: sentences[0] || fullResponse }));
      ttsWs.send(JSON.stringify({ type: "Flush" }));
    });

    ttsWs.on("message", (data, isBinary) => {
      if (isBinary) {
        if (!firstByte) firstByte = performance.now() - ttsStart;
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        totalBytes += buf.length;
      } else {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "Flushed" && !flushed) {
            flushed = true;
            resolve({
              firstByte: firstByte ?? 0,
              totalBytes,
              total: performance.now() - ttsStart,
            });
          }
        } catch {}
      }
    });

    ttsWs.on("error", reject);
    setTimeout(() => resolve({ firstByte: firstByte ?? 0, totalBytes, total: performance.now() - ttsStart }), 10000);
  });

  ttsWs.close();
  console.log(`  TTS first byte:    ${ttsResult.firstByte.toFixed(0)}ms`);
  console.log(`  TTS total:         ${ttsResult.total.toFixed(0)}ms`);
  console.log(`  Audio output:      ${(ttsResult.totalBytes / 1024).toFixed(1)} KB (~${(ttsResult.totalBytes / 8000).toFixed(1)}s)\n`);

  // --- Summary ---
  const totalE2E = sttTime + llmTotal + ttsResult.total;
  // Realistic latency = time from end of speech to first audio heard
  // STT endpointing (~300ms) + LLM first sentence + TTS first byte
  const realisticLatency = 300 + (firstSentenceTime ?? llmTotal) + ttsResult.firstByte;

  console.log("=== SUMMARY ===");
  console.log(`  STT time:                   ${sttTime.toFixed(0)}ms (overlaps with caller speaking)`);
  console.log(`  LLM TTFT:                   ${llmTTFT?.toFixed(0) ?? "N/A"}ms`);
  console.log(`  LLM first sentence:         ${firstSentenceTime?.toFixed(0) ?? "N/A"}ms`);
  console.log(`  TTS first byte:             ${ttsResult.firstByte.toFixed(0)}ms`);
  console.log(`  ---`);
  console.log(`  Perceived latency:          ~${realisticLatency.toFixed(0)}ms (endpointing + LLM sentence + TTS)`);
  console.log(`  Sequential total:           ${totalE2E.toFixed(0)}ms\n`);

  console.log("✓ Round-trip benchmark complete");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch(console.error);
