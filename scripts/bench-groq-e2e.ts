/**
 * Benchmark: Groq whisper-large-v3-turbo (STT) + llama-4-scout (LLM)
 * Full round-trip with real audio + Deepgram TTS
 */
import "dotenv/config";
import Groq from "groq-sdk";
import WebSocket from "ws";
import { readFileSync } from "fs";
import path from "path";

const groqKey = process.env.GROQ_API_KEY || process.env.GROK_API_KEY;
if (!groqKey) {
  throw new Error("Missing GROQ_API_KEY");
}
const groq = new Groq({ apiKey: groqKey });
const DG_KEY = process.env.DEEPGRAM_API_KEY!;
const INPUT_FILE = path.resolve(process.cwd(), "input.mp3");

const SYSTEM_PROMPT = `You are a friendly dental office receptionist. Keep responses brief and natural for a phone call.
Respond with only spoken words, no markdown. If the caller speaks in Hindi or Hinglish, respond in simple English but acknowledge you understood them.
Today's date is 2026-04-01.`;

async function main() {
  console.log("=== Groq E2E: whisper-large-v3-turbo + llama-4-scout + Deepgram TTS ===\n");

  const audioFile = readFileSync(INPUT_FILE);

  // Pre-connect TTS
  const ttsParams = new URLSearchParams({ model: "aura-2-thalia-en", encoding: "mulaw", sample_rate: "8000" });
  const ttsWs = new WebSocket(`wss://api.deepgram.com/v1/speak?${ttsParams}`, {
    headers: { Authorization: `Token ${DG_KEY}` },
  });
  await new Promise<void>((res, rej) => { ttsWs.on("open", res); ttsWs.on("error", rej); });
  console.log("TTS WebSocket pre-connected\n");

  // Run 3 times to see cold vs warm
  for (let run = 1; run <= 3; run++) {
    console.log(`--- Run ${run} ---`);
    const pipelineStart = performance.now();

    // Phase 1: STT
    const sttStart = performance.now();
    const transcription = await groq.audio.transcriptions.create({
      file: new File([audioFile], "input.mp3", { type: "audio/mpeg" }),
      model: "whisper-large-v3-turbo",
      language: "en",
    });
    const sttTime = performance.now() - sttStart;

    // Phase 2: LLM (streaming)
    const llmStart = performance.now();
    let ttft: number | null = null;
    let firstSentenceTime: number | null = null;
    let sentenceBuffer = "";
    let fullText = "";
    let sentenceCount = 0;
    const firstSentence: { text: string; time: number } = { text: "", time: 0 };

    const stream = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "assistant", content: "Thank you for calling Smile Dental Clinic. How can I help you today?" },
        { role: "user", content: transcription.text },
      ],
      max_tokens: 256,
      temperature: 0.7,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || "";
      if (!delta) continue;
      if (!ttft) ttft = performance.now() - llmStart;
      fullText += delta;
      sentenceBuffer += delta;

      if (/[.!?]$/.test(sentenceBuffer.trim()) && sentenceBuffer.trim().length > 10) {
        sentenceCount++;
        if (!firstSentenceTime) {
          firstSentenceTime = performance.now() - llmStart;
          firstSentence.text = sentenceBuffer.trim();
          firstSentence.time = performance.now() - pipelineStart;

          // Send first sentence to TTS immediately
          ttsWs.send(JSON.stringify({ type: "Speak", text: sentenceBuffer.trim() }));
          ttsWs.send(JSON.stringify({ type: "Flush" }));
        }
        sentenceBuffer = "";
      }
    }

    // Flush remaining
    if (sentenceBuffer.trim()) {
      sentenceCount++;
      if (!firstSentenceTime) {
        firstSentenceTime = performance.now() - llmStart;
        firstSentence.text = sentenceBuffer.trim();
        firstSentence.time = performance.now() - pipelineStart;
        ttsWs.send(JSON.stringify({ type: "Speak", text: sentenceBuffer.trim() }));
        ttsWs.send(JSON.stringify({ type: "Flush" }));
      }
    }

    const llmTotal = performance.now() - llmStart;

    // Phase 3: Wait for first TTS audio byte
    const ttsWaitStart = performance.now();
    const firstAudioByte = await new Promise<number>((resolve) => {
      const handler = (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          ttsWs.off("message", handler);
          resolve(performance.now() - pipelineStart);
        }
      };
      ttsWs.on("message", handler);
      setTimeout(() => { ttsWs.off("message", handler); resolve(-1); }, 10000);
    });

    const totalTime = performance.now() - pipelineStart;

    console.log(`  STT:                ${sttTime.toFixed(0)}ms`);
    console.log(`  Transcript:         "${transcription.text.slice(0, 80)}..."`);
    console.log(`  LLM TTFT:           ${ttft?.toFixed(0) ?? "N/A"}ms`);
    console.log(`  LLM 1st sentence:   ${firstSentenceTime?.toFixed(0) ?? "N/A"}ms — "${firstSentence.text.slice(0, 80)}"`);
    console.log(`  LLM total:          ${llmTotal.toFixed(0)}ms (${sentenceCount} sentences)`);
    console.log(`  First audio byte:   ${firstAudioByte > 0 ? firstAudioByte.toFixed(0) + "ms" : "TIMEOUT"}`);
    console.log(`  ---`);
    console.log(`  Perceived latency:  ${firstAudioByte > 0 ? firstAudioByte.toFixed(0) : "?"}ms  (STT + LLM sentence + TTS)\n`);
  }

  ttsWs.close();

  console.log("=== COMPARISON TABLE ===\n");
  console.log("Stack".padEnd(45) + "Perceived Latency");
  console.log("-".repeat(65));
  console.log("Deepgram STT + MiMo/OpenRouter + Deepgram TTS".padEnd(45) + "~4400ms");
  console.log("Deepgram STT + MiMo Direct + Deepgram TTS".padEnd(45) + "~1500ms");
  console.log("Groq Whisper + Groq Scout + Deepgram TTS".padEnd(45) + "see above");

  console.log("\n✓ Groq E2E benchmark complete");
}

main().catch(console.error);
