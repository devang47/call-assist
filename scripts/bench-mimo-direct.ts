/**
 * Benchmark: MiMo Direct API (api.xiaomimimo.com)
 * Tests TTFT and response quality with the direct MiMo endpoint
 */
import "dotenv/config";

const API_KEY = process.env.MIMO_API_KEY!;
const BASE_URL = "https://api.xiaomimimo.com/v1/chat/completions";

const MODELS = ["mimo-v2-flash", "mimo-v2-pro"];

const SYSTEM_PROMPT = `You are a friendly dental office receptionist. Keep responses brief and natural for a phone call.
Respond with only spoken words, no markdown. If the caller speaks in Hindi or Hinglish, respond in simple English but acknowledge you understood them.
Today's date is 2026-04-01.`;

const TEST_PROMPTS = [
  {
    name: "Indian English scheduling",
    messages: [
      { role: "assistant", content: "Thank you for calling Smile Dental Clinic. How can I help you today?" },
      { role: "user", content: "Haan ji, mujhe ek appointment chahiye. Kya aapke paas kal ka koi slot available hai? Mera tooth mein bahut dard ho raha hai." },
    ],
  },
  {
    name: "Hinglish casual",
    messages: [
      { role: "assistant", content: "Thank you for calling Smile Dental Clinic. How can I help you today?" },
      { role: "user", content: "Hi, I need to book a cleaning appointment. Actually mera last cleaning 6 months pehle hua tha. Do you have anything this week?" },
    ],
  },
  {
    name: "Quick query",
    messages: [
      { role: "assistant", content: "Thank you for calling Smile Dental Clinic. How can I help you today?" },
      { role: "user", content: "What time do you close today?" },
    ],
  },
];

async function benchModel(model: string) {
  console.log(`\n--- ${model} ---`);

  for (const tp of TEST_PROMPTS) {
    // Non-streaming first to test basic connectivity
    const start = performance.now();

    try {
      // Streaming request
      const res = await fetch(BASE_URL, {
        method: "POST",
        headers: {
          "api-key": API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            ...tp.messages,
          ],
          max_completion_tokens: 256,
          temperature: 0.7,
          stream: true,
        }),
      });

      if (!res.ok) {
        const errBody = await res.text();
        console.log(`  [${tp.name}] ERROR ${res.status}: ${errBody.slice(0, 120)}`);
        continue;
      }

      let ttft: number | null = null;
      let tokenCount = 0;
      let fullText = "";
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content ||
                          parsed.choices?.[0]?.delta?.reasoning_content || "";
            // Only count actual content, not reasoning
            const content = parsed.choices?.[0]?.delta?.content || "";
            if (content) {
              if (!ttft) ttft = performance.now() - start;
              tokenCount++;
              fullText += content;
            }
          } catch {}
        }
      }

      const total = performance.now() - start;
      console.log(`  [${tp.name}]`);
      console.log(`    TTFT: ${ttft?.toFixed(0) ?? "N/A"}ms | Total: ${total.toFixed(0)}ms | Tokens: ${tokenCount}`);
      console.log(`    Response: "${fullText.trim().slice(0, 120)}${fullText.length > 120 ? "..." : ""}"`);
    } catch (err: any) {
      console.log(`  [${tp.name}] FETCH ERROR: ${err.message}`);
    }
  }
}

async function main() {
  console.log("=== MiMo Direct API Benchmark ===");
  console.log(`Endpoint: ${BASE_URL}`);

  // Quick connectivity test
  console.log("\nTesting connectivity...");
  const testStart = performance.now();
  const testRes = await fetch(BASE_URL, {
    method: "POST",
    headers: { "api-key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "mimo-v2-flash",
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 10,
      stream: false,
    }),
  });
  const testBody = await testRes.text();
  console.log(`  Status: ${testRes.status} (${(performance.now() - testStart).toFixed(0)}ms)`);
  if (testRes.status !== 200) {
    console.log(`  Body: ${testBody.slice(0, 200)}`);
    return;
  }
  console.log(`  OK — API key valid\n`);

  for (const model of MODELS) {
    await benchModel(model);
  }

  // Compare summary
  console.log("\n\n=== Quick Comparison (add to previous results) ===");
  console.log("Provider".padEnd(30) + "Avg TTFT".padEnd(12) + "Notes");
  console.log("-".repeat(65));
  console.log("Groq (llama-4-scout)".padEnd(30) + "~130ms".padEnd(12) + "Fastest overall");
  console.log("MiMo Direct (see above)".padEnd(30) + "see above".padEnd(12) + "No routing overhead");
  console.log("OpenRouter (mimo-v2-flash)".padEnd(30) + "~1500ms".padEnd(12) + "Routing overhead");
  console.log("Deepgram TTS first byte".padEnd(30) + "~400ms".padEnd(12) + "Constant");

  console.log("\n✓ MiMo Direct benchmark complete");
}

main().catch(console.error);
