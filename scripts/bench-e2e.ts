/**
 * Benchmark: End-to-end pipeline latency
 * Simulates: text in → LLM → sentence buffer → TTS → first audio byte
 * This measures the real-world latency a caller experiences
 */
import "dotenv/config";
import WebSocket from "ws";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { streamText } from "ai";

const openrouter = createOpenRouter({
  apiKey: process.env.MIMO_API_KEY!,
});

const MODEL = process.env.MIMO_MODEL || "xiaomi/mimo-v2-flash";
const DG_KEY = process.env.DEEPGRAM_API_KEY!;

// Sentence boundary detection (same logic as sentence-buffer.ts)
function isSentenceEnd(text: string): boolean {
  return /[.!?]$/.test(text.trim());
}

async function benchE2E() {
  console.log("=== End-to-End Pipeline Latency Benchmark ===");
  console.log(`LLM: ${MODEL}`);
  console.log(`TTS: Deepgram aura-2-thalia-en\n`);

  // Pre-connect TTS WebSocket
  const ttsParams = new URLSearchParams({
    model: "aura-2-thalia-en",
    encoding: "mulaw",
    sample_rate: "8000",
  });

  const ttsWs = new WebSocket(`wss://api.deepgram.com/v1/speak?${ttsParams}`, {
    headers: { Authorization: `Token ${DG_KEY}` },
  });

  await new Promise<void>((resolve, reject) => {
    ttsWs.on("open", () => {
      console.log("TTS WebSocket connected\n");
      resolve();
    });
    ttsWs.on("error", reject);
  });

  const userInputs = [
    "I'd like to schedule a cleaning appointment",
    "Do you have anything available this Friday?",
    "What are your hours?",
  ];

  for (const input of userInputs) {
    await benchTurn(ttsWs, input);
  }

  ttsWs.close();
  console.log("✓ E2E benchmark complete");
}

async function benchTurn(ttsWs: WebSocket, userInput: string) {
  console.log(`--- User: "${userInput}" ---`);

  const pipelineStart = performance.now();
  let llmFirstToken: number | null = null;
  let firstSentenceSent: number | null = null;
  let firstAudioByte: number | null = null;
  let sentenceBuffer = "";
  let sentenceCount = 0;

  // Listen for TTS audio
  const audioPromise = new Promise<void>((resolve) => {
    const handler = (data: Buffer, isBinary: boolean) => {
      if (isBinary && !firstAudioByte) {
        firstAudioByte = performance.now() - pipelineStart;
        ttsWs.off("message", handler);
        resolve();
      }
    };
    ttsWs.on("message", handler);

    // Timeout
    setTimeout(() => {
      ttsWs.off("message", handler);
      resolve();
    }, 15000);
  });

  // Start LLM
  try {
    const result = streamText({
      model: openrouter.chat(MODEL),
      system: "You are a dental office receptionist. Keep responses brief and natural for a phone call. Respond with only spoken words, no markdown.",
      messages: [
        { role: "assistant", content: "Thank you for calling Smile Dental Clinic. How can I help you today?" },
        { role: "user", content: userInput },
      ],
      maxOutputTokens: 256,
      temperature: 0.7,
    });

    for await (const delta of result.textStream) {
      if (!llmFirstToken) {
        llmFirstToken = performance.now() - pipelineStart;
      }

      sentenceBuffer += delta;

      // Check for sentence boundary
      if (isSentenceEnd(sentenceBuffer) && sentenceBuffer.trim().length > 10) {
        sentenceCount++;
        if (!firstSentenceSent) {
          firstSentenceSent = performance.now() - pipelineStart;
        }
        // Send to TTS
        ttsWs.send(JSON.stringify({ type: "Speak", text: sentenceBuffer.trim() }));
        ttsWs.send(JSON.stringify({ type: "Flush" }));
        sentenceBuffer = "";
      }
    }

    // Flush remaining
    if (sentenceBuffer.trim()) {
      sentenceCount++;
      if (!firstSentenceSent) {
        firstSentenceSent = performance.now() - pipelineStart;
      }
      ttsWs.send(JSON.stringify({ type: "Speak", text: sentenceBuffer.trim() }));
      ttsWs.send(JSON.stringify({ type: "Flush" }));
    }
  } catch (err: any) {
    console.log(`  LLM ERROR: ${err.message}\n`);
    return;
  }

  // Wait for first audio byte
  await audioPromise;

  const totalTime = performance.now() - pipelineStart;

  console.log(`  LLM TTFT:             ${llmFirstToken?.toFixed(0) ?? "N/A"}ms`);
  console.log(`  First sentence ready:  ${firstSentenceSent?.toFixed(0) ?? "N/A"}ms`);
  console.log(`  First audio byte:      ${firstAudioByte?.toFixed(0) ?? "N/A"}ms  ← caller hears this`);
  console.log(`  Total pipeline time:   ${totalTime.toFixed(0)}ms`);
  console.log(`  Sentences streamed:    ${sentenceCount}\n`);
}

benchE2E().catch(console.error);
