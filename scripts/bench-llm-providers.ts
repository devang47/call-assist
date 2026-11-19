import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import "dotenv/config";
import Groq from "groq-sdk";

const GROQ_KEY = process.env.GROQ_API_KEY || process.env.GROK_API_KEY;
const MIMO_KEY = process.env.MIMO_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const SYSTEM_PROMPT =
  "You are a dental office receptionist. Keep responses short, natural, and suitable for a phone call. Ask one question at a time and respond with spoken words only.";

const TEST_CASES = [
  {
    name: "Scheduling request",
    messages: [
      { role: "assistant" as const, content: "Thank you for calling Smile Dental Clinic. How can I help you today?" },
      { role: "user" as const, content: "Hi, I need a cleaning appointment for next Tuesday afternoon." },
    ],
  },
  {
    name: "Hinglish request",
    messages: [
      { role: "assistant" as const, content: "Thank you for calling Smile Dental Clinic. How can I help you today?" },
      { role: "user" as const, content: "Haan ji, mujhe ek appointment chahiye. Kal ka koi slot available hai?" },
    ],
  },
  {
    name: "Practice info",
    messages: [
      { role: "assistant" as const, content: "Thank you for calling Smile Dental Clinic. How can I help you today?" },
      { role: "user" as const, content: "What time do you close on Saturday?" },
    ],
  },
];

interface LLMResult {
  provider: string;
  model: string;
  prompt: string;
  ttftMs: number;
  firstSentenceMs: number;
  totalMs: number;
  text: string;
  ok: boolean;
  note?: string;
}

function clip(text: string, max = 96): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}

async function collectStream(chunks: AsyncIterable<string>): Promise<{ ttftMs: number; firstSentenceMs: number; totalMs: number; text: string }> {
  const start = performance.now();
  let ttftMs = -1;
  let firstSentenceMs = -1;
  let text = "";

  for await (const chunk of chunks) {
    if (!chunk) continue;
    if (ttftMs < 0) ttftMs = performance.now() - start;
    text += chunk;
    if (firstSentenceMs < 0 && /[.!?]/.test(text)) {
      firstSentenceMs = performance.now() - start;
    }
  }

  return {
    ttftMs,
    firstSentenceMs: firstSentenceMs >= 0 ? firstSentenceMs : ttftMs,
    totalMs: performance.now() - start,
    text,
  };
}

async function* groqChunks(model: string, messages: { role: "system" | "assistant" | "user"; content: string }[]) {
  if (!GROQ_KEY) throw new Error("Missing GROQ_API_KEY");
  const groq = new Groq({ apiKey: GROQ_KEY });
  const stream = await groq.chat.completions.create({
    model,
    messages,
    max_tokens: 120,
    reasoning_effort: model.startsWith("qwen/") ? "none" : "low",
    temperature: 0.3,
    stream: true,
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content || "";
    if (delta) yield delta;
  }
}

async function* mimoChunks(model: string, messages: { role: "system" | "assistant" | "user"; content: string }[]) {
  if (!MIMO_KEY) throw new Error("Missing MIMO_API_KEY");

  const res = await fetch("https://api.xiaomimimo.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "api-key": MIMO_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      max_completion_tokens: 120,
      temperature: 0.3,
      stream: true,
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }

  const reader = res.body.getReader();
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
        const chunk = parsed.choices?.[0]?.delta?.content || "";
        if (chunk) yield chunk;
      } catch {
        // ignore parse noise
      }
    }
  }
}

async function* openAIChunks(model: string, messages: { role: "system" | "assistant" | "user"; content: string }[]) {
  if (!OPENAI_KEY) throw new Error("Missing OPENAI_API_KEY");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 120,
      temperature: 0.3,
      stream: true,
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }

  const reader = res.body.getReader();
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
        const chunk = parsed.choices?.[0]?.delta?.content || "";
        if (chunk) yield chunk;
      } catch {
        // ignore parse noise
      }
    }
  }
}

async function runOne(
  provider: string,
  model: string,
  promptName: string,
  chunkFactory: (messages: { role: "system" | "assistant" | "user"; content: string }[]) => AsyncIterable<string>,
  messages: { role: "assistant" | "user"; content: string }[],
): Promise<LLMResult> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const streamed = await collectStream(
        chunkFactory([{ role: "system", content: SYSTEM_PROMPT }, ...messages]),
      );

      return {
        provider,
        model,
        prompt: promptName,
        ttftMs: streamed.ttftMs,
        firstSentenceMs: streamed.firstSentenceMs,
        totalMs: streamed.totalMs,
        text: streamed.text,
        ok: true,
      };
    } catch (err) {
      lastError = err;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      }
    }
  }

  return {
    provider,
    model,
    prompt: promptName,
    ttftMs: -1,
    firstSentenceMs: -1,
    totalMs: -1,
    text: "",
    ok: false,
    note: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

async function runProvider(provider: string, model: string, chunkFactory: (messages: { role: "system" | "assistant" | "user"; content: string }[]) => AsyncIterable<string>) {
  const results: LLMResult[] = [];
  for (const testCase of TEST_CASES) {
    results.push(await runOne(provider, model, testCase.name, chunkFactory, testCase.messages));
  }
  return results;
}

function printSummary(results: LLMResult[]) {
  const grouped = new Map<string, LLMResult[]>();
  for (const result of results) {
    const key = `${result.provider} / ${result.model}`;
    const existing = grouped.get(key) || [];
    existing.push(result);
    grouped.set(key, existing);
  }

  console.log("Summary");
  console.log("Provider".padEnd(18) + "Model".padEnd(34) + "Avg TTFT".padEnd(12) + "Avg First".padEnd(12) + "Status");
  console.log("-".repeat(90));

  Array.from(grouped.entries())
    .map(([key, values]) => {
      const [provider, model] = key.split(" / ");
      const ok = values.filter((value) => value.ok);
      const avgTTFT = ok.reduce((sum, value) => sum + value.ttftMs, 0) / Math.max(ok.length, 1);
      const avgFirst = ok.reduce((sum, value) => sum + value.firstSentenceMs, 0) / Math.max(ok.length, 1);
      return { provider, model, avgTTFT, avgFirst, okCount: ok.length, total: values.length, note: values.find((value) => !value.ok)?.note };
    })
    .sort((a, b) => (a.okCount === b.okCount ? a.avgTTFT - b.avgTTFT : b.okCount - a.okCount))
    .forEach((row) => {
      const status = row.okCount === row.total ? "OK" : clip(row.note || "partial failure", 24);
      console.log(
        row.provider.padEnd(18) +
        row.model.padEnd(34) +
        (row.okCount ? `${row.avgTTFT.toFixed(0)}ms` : "n/a").padEnd(12) +
        (row.okCount ? `${row.avgFirst.toFixed(0)}ms` : "n/a").padEnd(12) +
        status
      );
    });
}

async function main() {
  console.log("=== LLM Provider Benchmark ===\n");

  const results = [
    ...(await runProvider("Groq", "qwen/qwen3.8-27b", (messages) => groqChunks("qwen/qwen3.8-27b", messages))),
    ...(await runProvider("Groq", "openai/gpt-oss-120b", (messages) => groqChunks("openai/gpt-oss-120b", messages))),
    ...(await runProvider("Groq", "openai/gpt-oss-20b", (messages) => groqChunks("openai/gpt-oss-20b", messages))),
    ...(await runProvider("MiMo", "mimo-v2-flash", (messages) => mimoChunks("mimo-v2-flash", messages))),
    ...(await runProvider("MiMo", "mimo-v2-pro", (messages) => mimoChunks("mimo-v2-pro", messages))),
    ...(await runProvider("OpenAI", "gpt-4o-mini", (messages) => openAIChunks("gpt-4o-mini", messages))),
  ];

  for (const result of results) {
    console.log(`--- ${result.provider} / ${result.model} / ${result.prompt} ---`);
    if (!result.ok) {
      console.log(`  ERROR: ${result.note}\n`);
      continue;
    }

    console.log(`  TTFT:           ${result.ttftMs.toFixed(0)}ms`);
    console.log(`  First sentence: ${result.firstSentenceMs.toFixed(0)}ms`);
    console.log(`  Total:          ${result.totalMs.toFixed(0)}ms`);
    console.log(`  Response:       "${clip(result.text)}"\n`);
  }

  printSummary(results);
  console.log("\n✓ LLM provider benchmark complete");
}

main().catch(console.error);
