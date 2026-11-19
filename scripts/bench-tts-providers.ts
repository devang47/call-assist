import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import "dotenv/config";
import WebSocket from "ws";

const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const FAL_KEY = process.env.FAL_KEY;

const TEST_PHRASES = [
  "Hello, how can I help you today?",
  "I have openings at ten AM, two PM, and four PM on Tuesday. Which works best for you?",
  "Great, you're booked for Tuesday at two PM for a cleaning. Is there anything else I can help with?",
];

interface TTSResult {
  provider: string;
  model: string;
  phrase: string;
  firstByteMs: number;
  totalMs: number;
  ok: boolean;
  note?: string;
}

function clip(text: string, max = 72): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

async function benchDeepgramPhrase(ws: WebSocket, model: string, text: string): Promise<TTSResult> {
  return new Promise((resolve) => {
    let firstByteMs = -1;
    const start = performance.now();
    let done = false;
    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      ws.off("message", handler);
      resolve({
        provider: "Deepgram",
        model,
        phrase: text,
        firstByteMs,
        totalMs: performance.now() - start,
        ok: false,
        note: "Timed out waiting for Flushed event",
      });
    }, 15000);

    const handler = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        if (firstByteMs < 0) {
          firstByteMs = performance.now() - start;
        }
        return;
      }

      try {
        const message = JSON.parse(data.toString());
        if (message.type === "Flushed" && !done) {
          done = true;
          clearTimeout(timeout);
          ws.off("message", handler);
          resolve({
            provider: "Deepgram",
            model,
            phrase: text,
            firstByteMs,
            totalMs: performance.now() - start,
            ok: true,
          });
        }
      } catch {
        // ignore
      }
    };

    ws.on("message", handler);
    ws.send(JSON.stringify({ type: "Speak", text }));
    ws.send(JSON.stringify({ type: "Flush" }));
  });
}

async function benchDeepgram(model: string): Promise<TTSResult[]> {
  if (!DEEPGRAM_KEY) {
    return TEST_PHRASES.map((phrase) => ({
      provider: "Deepgram",
      model,
      phrase,
      firstByteMs: -1,
      totalMs: -1,
      ok: false,
      note: "Missing DEEPGRAM_API_KEY",
    }));
  }

  const params = new URLSearchParams({
    model,
    encoding: "mulaw",
    sample_rate: "8000",
  });

  const ws = new WebSocket(`wss://api.deepgram.com/v1/speak?${params}`, {
    headers: { Authorization: `Token ${DEEPGRAM_KEY}` },
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  const results: TTSResult[] = [];
  for (const phrase of TEST_PHRASES) {
    results.push(await benchDeepgramPhrase(ws, model, phrase));
  }

  ws.removeAllListeners();
  ws.terminate();
  return results;
}

async function benchOpenAI(model: string, voice: string): Promise<TTSResult[]> {
  if (!OPENAI_KEY) {
    return TEST_PHRASES.map((phrase) => ({
      provider: "OpenAI",
      model: `${model}/${voice}`,
      phrase,
      firstByteMs: -1,
      totalMs: -1,
      ok: false,
      note: "Missing OPENAI_API_KEY",
    }));
  }

  const results: TTSResult[] = [];

  for (const phrase of TEST_PHRASES) {
    const start = performance.now();
    try {
      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          voice,
          input: phrase,
          format: "mp3",
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      }

      const reader = res.body.getReader();
      let firstByteMs = -1;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length && firstByteMs < 0) {
          firstByteMs = performance.now() - start;
        }
      }

      results.push({
        provider: "OpenAI",
        model: `${model}/${voice}`,
        phrase,
        firstByteMs,
        totalMs: performance.now() - start,
        ok: true,
      });
    } catch (err) {
      results.push({
        provider: "OpenAI",
        model: `${model}/${voice}`,
        phrase,
        firstByteMs: -1,
        totalMs: performance.now() - start,
        ok: false,
        note: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

async function benchFal(model: string, voice: string): Promise<TTSResult[]> {
  if (!FAL_KEY) {
    return TEST_PHRASES.map((phrase) => ({
      provider: "fal.ai",
      model: `${model}/${voice}`,
      phrase,
      firstByteMs: -1,
      totalMs: -1,
      ok: false,
      note: "Missing FAL_KEY",
    }));
  }

  const results: TTSResult[] = [];

  for (const phrase of TEST_PHRASES) {
    const start = performance.now();

    try {
      const res = await fetch(`https://fal.run/${model}`, {
        method: "POST",
        headers: {
          Authorization: `Key ${FAL_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: phrase,
          voice,
          language: "English",
        }),
      });

      const json = await res.json() as any;
      if (!res.ok) {
        throw new Error(JSON.stringify(json).slice(0, 160));
      }

      const audioUrl = json.audio?.url;
      if (!audioUrl) {
        throw new Error("No audio URL returned");
      }

      const audioRes = await fetch(audioUrl);
      if (!audioRes.ok || !audioRes.body) {
        throw new Error(`Audio download failed: HTTP ${audioRes.status}`);
      }

      const reader = audioRes.body.getReader();
      let firstByteMs = -1;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length && firstByteMs < 0) {
          firstByteMs = performance.now() - start;
        }
      }

      results.push({
        provider: "fal.ai",
        model: `${model}/${voice}`,
        phrase,
        firstByteMs,
        totalMs: performance.now() - start,
        ok: true,
      });
    } catch (err) {
      results.push({
        provider: "fal.ai",
        model: `${model}/${voice}`,
        phrase,
        firstByteMs: -1,
        totalMs: performance.now() - start,
        ok: false,
        note: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

function printSummary(results: TTSResult[]) {
  const grouped = new Map<string, TTSResult[]>();
  for (const result of results) {
    const key = `${result.provider} / ${result.model}`;
    const existing = grouped.get(key) || [];
    existing.push(result);
    grouped.set(key, existing);
  }

  console.log("Summary");
  console.log("Provider".padEnd(14) + "Model".padEnd(44) + "Avg first".padEnd(12) + "Avg total".padEnd(12) + "Status");
  console.log("-".repeat(96));

  Array.from(grouped.entries())
    .map(([key, values]) => {
      const [provider, model] = key.split(" / ");
      const ok = values.filter((value) => value.ok);
      const avgFirst = ok.reduce((sum, value) => sum + value.firstByteMs, 0) / Math.max(ok.length, 1);
      const avgTotal = ok.reduce((sum, value) => sum + value.totalMs, 0) / Math.max(ok.length, 1);
      return { provider, model, avgFirst, avgTotal, okCount: ok.length, total: values.length, note: values.find((value) => !value.ok)?.note };
    })
    .sort((a, b) => (a.okCount === b.okCount ? a.avgFirst - b.avgFirst : b.okCount - a.okCount))
    .forEach((row) => {
      const status = row.okCount === row.total ? "OK" : clip(row.note || "partial failure", 24);
      console.log(
        row.provider.padEnd(14) +
        row.model.padEnd(44) +
        (row.okCount ? `${row.avgFirst.toFixed(0)}ms` : "n/a").padEnd(12) +
        (row.okCount ? `${row.avgTotal.toFixed(0)}ms` : "n/a").padEnd(12) +
        status
      );
    });
}

async function main() {
  console.log("=== TTS Provider Benchmark ===\n");

  const results = [
    ...(await benchDeepgram("aura-2-thalia-en")),
    ...(await benchFal("fal-ai/qwen-3-tts/text-to-speech/0.6b", "Vivian")),
    ...(await benchOpenAI("gpt-4o-mini-tts", "alloy")),
  ];

  for (const result of results) {
    console.log(`--- ${result.provider} / ${result.model} ---`);
    console.log(`  Phrase: "${clip(result.phrase)}"`);
    if (!result.ok) {
      console.log(`  ERROR:  ${result.note}\n`);
      continue;
    }

    console.log(`  First byte: ${result.firstByteMs.toFixed(0)}ms`);
    console.log(`  Total:      ${result.totalMs.toFixed(0)}ms\n`);
  }

  printSummary(results);
  console.log("\n✓ TTS provider benchmark complete");
}

main().catch(console.error);
