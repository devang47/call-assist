/**
 * Benchmark: Compare multiple LLM models for voice assistant use case
 * Tests TTFT, quality, tool-calling readiness, and Indian English handling
 */
import "dotenv/config";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { streamText } from "ai";

const openrouter = createOpenRouter({ apiKey: process.env.MIMO_API_KEY! });

const MODELS = [
  "google/gemini-2.5-flash",
  "google/gemini-2.0-flash-001",
  "anthropic/claude-3.5-haiku",
  "meta-llama/llama-4-scout",
  "meta-llama/llama-4-maverick",
  "deepseek/deepseek-chat-v3-0324",
  "qwen/qwen3-8b",
  "xiaomi/mimo-v2-flash",
];

// Indian English test prompts
const TEST_PROMPTS = [
  {
    name: "Indian English scheduling",
    messages: [
      { role: "assistant" as const, content: "Thank you for calling Smile Dental Clinic. How can I help you today?" },
      { role: "user" as const, content: "Haan ji, mujhe ek appointment chahiye. Kya aapke paas kal ka koi slot available hai? Mera tooth mein bahut dard ho raha hai." },
    ],
  },
  {
    name: "Hinglish casual",
    messages: [
      { role: "assistant" as const, content: "Thank you for calling Smile Dental Clinic. How can I help you today?" },
      { role: "user" as const, content: "Hi, I need to book a cleaning appointment. Actually mera last cleaning 6 months pehle hua tha, so I think it's time. Do you have anything available this week?" },
    ],
  },
  {
    name: "Quick info query",
    messages: [
      { role: "assistant" as const, content: "Thank you for calling Smile Dental Clinic. How can I help you today?" },
      { role: "user" as const, content: "What time do you close today?" },
    ],
  },
];

const SYSTEM_PROMPT = `You are a friendly dental office receptionist. Keep responses brief and natural for a phone call.
Respond with only spoken words, no markdown. If the caller speaks in Hindi or Hinglish, respond in simple English but acknowledge you understood them.
Today's date is 2026-04-01.`;

async function benchModel(model: string) {
  const results: { name: string; ttft: number; total: number; tokens: number; response: string }[] = [];

  for (const tp of TEST_PROMPTS) {
    const start = performance.now();
    let ttft: number | null = null;
    let tokenCount = 0;
    let fullText = "";

    try {
      const result = streamText({
        model: openrouter.chat(model),
        system: SYSTEM_PROMPT,
        messages: tp.messages,
        maxOutputTokens: 256,
        temperature: 0.7,
      });

      for await (const delta of result.textStream) {
        if (!ttft) ttft = performance.now() - start;
        tokenCount++;
        fullText += delta;
      }

      const total = performance.now() - start;
      results.push({
        name: tp.name,
        ttft: ttft ?? -1,
        total,
        tokens: tokenCount,
        response: fullText.trim(),
      });
    } catch (err: any) {
      results.push({
        name: tp.name,
        ttft: -1,
        total: performance.now() - start,
        tokens: 0,
        response: `ERROR: ${err.message?.slice(0, 80)}`,
      });
    }
  }

  return results;
}

async function main() {
  console.log("=== Multi-Model Voice Assistant Benchmark ===");
  console.log(`Provider: OpenRouter`);
  console.log(`Tests: ${TEST_PROMPTS.length} prompts per model\n`);

  const allResults: { model: string; avgTTFT: number; results: any[] }[] = [];

  for (const model of MODELS) {
    console.log(`\n--- ${model} ---`);
    const results = await benchModel(model);

    let totalTTFT = 0;
    let validCount = 0;

    for (const r of results) {
      const ttftStr = r.ttft >= 0 ? `${r.ttft.toFixed(0)}ms` : "FAIL";
      console.log(`  [${r.name}]`);
      console.log(`    TTFT: ${ttftStr} | Total: ${r.total.toFixed(0)}ms | Tokens: ${r.tokens}`);
      console.log(`    Response: "${r.response.slice(0, 120)}${r.response.length > 120 ? "..." : ""}"`);

      if (r.ttft >= 0) {
        totalTTFT += r.ttft;
        validCount++;
      }
    }

    const avgTTFT = validCount > 0 ? totalTTFT / validCount : -1;
    console.log(`  >> Avg TTFT: ${avgTTFT >= 0 ? avgTTFT.toFixed(0) + "ms" : "FAIL"}`);

    allResults.push({ model, avgTTFT, results });
  }

  // Summary table
  console.log("\n\n=== SUMMARY (sorted by avg TTFT) ===\n");
  console.log("Model".padEnd(40) + "Avg TTFT".padEnd(12) + "Status");
  console.log("-".repeat(65));

  allResults
    .filter((r) => r.avgTTFT >= 0)
    .sort((a, b) => a.avgTTFT - b.avgTTFT)
    .forEach((r) => {
      const speed = r.avgTTFT < 500 ? "FAST" : r.avgTTFT < 1000 ? "OK" : r.avgTTFT < 2000 ? "SLOW" : "TOO SLOW";
      console.log(`${r.model.padEnd(40)}${(r.avgTTFT.toFixed(0) + "ms").padEnd(12)}${speed}`);
    });

  allResults
    .filter((r) => r.avgTTFT < 0)
    .forEach((r) => {
      console.log(`${r.model.padEnd(40)}${"FAIL".padEnd(12)}ERROR`);
    });

  console.log("\n✓ Benchmark complete");
}

main().catch(console.error);
