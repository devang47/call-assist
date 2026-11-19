import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import "dotenv/config";
import { readFileSync } from "fs";
import path from "path";
import Groq from "groq-sdk";

const INPUT_FILE = path.resolve(process.cwd(), "input.mp3");
const INPUT_AUDIO = readFileSync(INPUT_FILE);
const GROQ_KEY = process.env.GROQ_API_KEY || process.env.GROK_API_KEY;
const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

interface BenchResult {
  provider: string;
  model: string;
  elapsedMs: number;
  transcript: string;
  ok: boolean;
  note?: string;
}

function clip(text: string, max = 96): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      }
    }
  }
  throw lastError;
}

async function benchGroq(model: string): Promise<BenchResult> {
  if (!GROQ_KEY) {
    return { provider: "Groq", model, elapsedMs: 0, transcript: "", ok: false, note: "Missing GROQ_API_KEY" };
  }

  const groq = new Groq({ apiKey: GROQ_KEY });
  const start = performance.now();

  try {
    const transcription = await withRetry(() =>
      groq.audio.transcriptions.create({
        file: new File([INPUT_AUDIO], "input.mp3", { type: "audio/mpeg" }),
        model,
        prompt:
          "dental appointment cleaning checkup filling extraction root canal crown whitening consultation emergency Hinglish Hindi schedule available booking cancel",
      })
    );

    return {
      provider: "Groq",
      model,
      elapsedMs: performance.now() - start,
      transcript: transcription.text?.trim() || "",
      ok: true,
    };
  } catch (err) {
    return {
      provider: "Groq",
      model,
      elapsedMs: performance.now() - start,
      transcript: "",
      ok: false,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

async function benchDeepgram(model: string): Promise<BenchResult> {
  if (!DEEPGRAM_KEY) {
    return { provider: "Deepgram", model, elapsedMs: 0, transcript: "", ok: false, note: "Missing DEEPGRAM_API_KEY" };
  }

  const start = performance.now();

  try {
    const res = await withRetry(() =>
      fetch(`https://api.deepgram.com/v1/listen?model=${encodeURIComponent(model)}&smart_format=true`, {
        method: "POST",
        headers: {
          Authorization: `Token ${DEEPGRAM_KEY}`,
          "Content-Type": "audio/mpeg",
        },
        body: INPUT_AUDIO,
      })
    );

    const json = await res.json() as any;
    if (!res.ok) {
      throw new Error(JSON.stringify(json).slice(0, 200));
    }

    return {
      provider: "Deepgram",
      model,
      elapsedMs: performance.now() - start,
      transcript: json.results?.channels?.[0]?.alternatives?.[0]?.transcript || "",
      ok: true,
    };
  } catch (err) {
    return {
      provider: "Deepgram",
      model,
      elapsedMs: performance.now() - start,
      transcript: "",
      ok: false,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

async function benchOpenAI(model: string): Promise<BenchResult> {
  if (!OPENAI_KEY) {
    return { provider: "OpenAI", model, elapsedMs: 0, transcript: "", ok: false, note: "Missing OPENAI_API_KEY" };
  }

  const form = new FormData();
  form.set("model", model);
  form.set("file", new Blob([INPUT_AUDIO], { type: "audio/mpeg" }), "input.mp3");

  const start = performance.now();

  try {
    const res = await withRetry(() =>
      fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
        },
        body: form,
      })
    );

    const json = await res.json() as any;
    if (!res.ok) {
      throw new Error(JSON.stringify(json).slice(0, 200));
    }

    return {
      provider: "OpenAI",
      model,
      elapsedMs: performance.now() - start,
      transcript: json.text || "",
      ok: true,
    };
  } catch (err) {
    return {
      provider: "OpenAI",
      model,
      elapsedMs: performance.now() - start,
      transcript: "",
      ok: false,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  console.log("=== STT Provider Benchmark ===\n");
  console.log(`Input: ${INPUT_FILE}\n`);

  const results = [
    await benchGroq("whisper-large-v3-turbo"),
    await benchGroq("whisper-large-v3"),
    await benchDeepgram("nova-3"),
    await benchOpenAI("gpt-4o-mini-transcribe"),
    await benchOpenAI("gpt-4o-transcribe"),
  ];

  for (const result of results) {
    console.log(`--- ${result.provider} / ${result.model} ---`);
    if (!result.ok) {
      console.log(`  ERROR: ${result.note}\n`);
      continue;
    }

    console.log(`  Total time: ${result.elapsedMs.toFixed(0)}ms`);
    console.log(`  Transcript: "${clip(result.transcript)}"\n`);
  }

  console.log("Summary");
  console.log("Provider".padEnd(14) + "Model".padEnd(32) + "Time".padEnd(10) + "Status");
  console.log("-".repeat(70));

  results
    .sort((a, b) => (a.ok === b.ok ? a.elapsedMs - b.elapsedMs : a.ok ? -1 : 1))
    .forEach((result) => {
      console.log(
        result.provider.padEnd(14) +
        result.model.padEnd(32) +
        (result.ok ? `${result.elapsedMs.toFixed(0)}ms` : "n/a").padEnd(10) +
        (result.ok ? "OK" : clip(result.note || "error", 24))
      );
    });

  console.log("\n✓ STT provider benchmark complete");
}

main().catch(console.error);
