/**
 * Benchmark: LLM (MiMo via OpenRouter) latency
 * Measures time-to-first-token and total response time
 */
import "dotenv/config";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { streamText } from "ai";

const openrouter = createOpenRouter({
  apiKey: process.env.MIMO_API_KEY!,
});

const MODEL = process.env.MIMO_MODEL || "xiaomi/mimo-v2-flash";

const testCases = [
  {
    name: "Simple greeting response",
    messages: [
      { role: "user" as const, content: "Hello, I'd like to book a dental appointment" },
    ],
  },
  {
    name: "Follow-up with context",
    messages: [
      { role: "assistant" as const, content: "Thank you for calling Smile Dental Clinic. How can I help you today?" },
      { role: "user" as const, content: "I need a cleaning appointment for next Monday" },
    ],
  },
  {
    name: "Multi-turn conversation",
    messages: [
      { role: "assistant" as const, content: "Thank you for calling Smile Dental Clinic. How can I help you today?" },
      { role: "user" as const, content: "I need a cleaning appointment" },
      { role: "assistant" as const, content: "I'd be happy to help you with a cleaning appointment. What date works best for you?" },
      { role: "user" as const, content: "How about this Friday afternoon?" },
    ],
  },
];

async function benchLLM() {
  console.log(`=== LLM Latency Benchmark ===`);
  console.log(`Model: ${MODEL}\n`);

  for (const tc of testCases) {
    console.log(`--- ${tc.name} ---`);

    const start = performance.now();
    let firstTokenTime: number | null = null;
    let tokenCount = 0;
    let fullText = "";

    try {
      const result = streamText({
        model: openrouter.chat(MODEL),
        system: "You are a dental office receptionist. Keep responses brief and natural for a phone call. Respond with only spoken words, no markdown.",
        messages: tc.messages,
        maxOutputTokens: 256,
        temperature: 0.7,
      });

      for await (const delta of result.textStream) {
        if (!firstTokenTime) {
          firstTokenTime = performance.now() - start;
        }
        tokenCount++;
        fullText += delta;
      }

      const totalTime = performance.now() - start;

      console.log(`  TTFT (time to first token): ${firstTokenTime?.toFixed(0) ?? "N/A"}ms`);
      console.log(`  Total response time:        ${totalTime.toFixed(0)}ms`);
      console.log(`  Tokens generated:           ${tokenCount}`);
      console.log(`  Tokens/sec:                 ${(tokenCount / (totalTime / 1000)).toFixed(1)}`);
      console.log(`  Response: "${fullText.slice(0, 80)}${fullText.length > 80 ? "..." : ""}"\n`);
    } catch (err: any) {
      console.log(`  ERROR: ${err.message}\n`);
    }
  }

  console.log("✓ LLM benchmark complete");
}

benchLLM().catch(console.error);
