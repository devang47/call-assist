/**
 * Benchmark: Groq — STT (Whisper) + LLM (Llama/Gemma)
 * Tests Groq's full pipeline latency for voice assistant use case
 */
import "dotenv/config";
import Groq from "groq-sdk";
import { readFileSync } from "fs";
import path from "path";

const groq = new Groq({ apiKey: process.env.GROK_API_KEY });
const INPUT_FILE = path.resolve(process.cwd(), "input.mp3");

// Models available on Groq
const LLM_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "gemma2-9b-it",
  "meta-llama/llama-4-scout-17b-16e-instruct",
];

const STT_MODELS = [
  "whisper-large-v3",
  "whisper-large-v3-turbo",
  "distil-whisper-large-v3-en",
];

const SYSTEM_PROMPT = `You are a friendly dental office receptionist. Keep responses brief and natural for a phone call.
Respond with only spoken words, no markdown. If the caller speaks in Hindi or Hinglish, respond in simple English but acknowledge you understood them.
Today's date is 2026-04-01.`;

async function benchSTT() {
  console.log("=== Groq STT Benchmark ===\n");

  const audioFile = readFileSync(INPUT_FILE);

  for (const model of STT_MODELS) {
    console.log(`--- ${model} ---`);
    const start = performance.now();

    try {
      const transcription = await groq.audio.transcriptions.create({
        file: new File([audioFile], "input.mp3", { type: "audio/mpeg" }),
        model,
        language: "en",
      });

      const elapsed = performance.now() - start;
      console.log(`  Time:       ${elapsed.toFixed(0)}ms`);
      console.log(`  Transcript: "${transcription.text}"\n`);
    } catch (err: any) {
      const elapsed = performance.now() - start;
      console.log(`  ERROR (${elapsed.toFixed(0)}ms): ${err.message?.slice(0, 100)}\n`);
    }
  }
}

async function benchLLM() {
  console.log("=== Groq LLM Benchmark ===\n");

  const testMessages = [
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
        { role: "user" as const, content: "Hi, I need to book a cleaning appointment. Actually mera last cleaning 6 months pehle hua tha. Do you have anything this week?" },
      ],
    },
    {
      name: "Quick query",
      messages: [
        { role: "assistant" as const, content: "Thank you for calling Smile Dental Clinic. How can I help you today?" },
        { role: "user" as const, content: "What time do you close today?" },
      ],
    },
  ];

  for (const model of LLM_MODELS) {
    console.log(`--- ${model} ---`);

    for (const tp of testMessages) {
      const start = performance.now();
      let ttft: number | null = null;
      let tokenCount = 0;
      let fullText = "";

      try {
        const stream = await groq.chat.completions.create({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            ...tp.messages,
          ],
          max_tokens: 256,
          temperature: 0.7,
          stream: true,
        });

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content || "";
          if (delta && !ttft) ttft = performance.now() - start;
          tokenCount++;
          fullText += delta;
        }

        const total = performance.now() - start;
        console.log(`  [${tp.name}]`);
        console.log(`    TTFT: ${ttft?.toFixed(0) ?? "N/A"}ms | Total: ${total.toFixed(0)}ms | Tokens: ${tokenCount}`);
        console.log(`    Response: "${fullText.trim().slice(0, 120)}${fullText.length > 120 ? "..." : ""}"`);
      } catch (err: any) {
        console.log(`  [${tp.name}] ERROR: ${err.message?.slice(0, 100)}`);
      }
    }

    console.log();
  }
}

async function benchE2E() {
  console.log("=== Groq End-to-End: STT → LLM ===\n");

  const audioFile = readFileSync(INPUT_FILE);

  // STT
  const sttStart = performance.now();
  const transcription = await groq.audio.transcriptions.create({
    file: new File([audioFile], "input.mp3", { type: "audio/mpeg" }),
    model: "whisper-large-v3-turbo",
    language: "en",
  });
  const sttTime = performance.now() - sttStart;
  console.log(`STT (whisper-large-v3-turbo): ${sttTime.toFixed(0)}ms`);
  console.log(`Transcript: "${transcription.text}"\n`);

  // LLM with best model
  const llmModel = "llama-3.3-70b-versatile";
  const llmStart = performance.now();
  let ttft: number | null = null;
  let fullText = "";

  const stream = await groq.chat.completions.create({
    model: llmModel,
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
    if (delta && !ttft) ttft = performance.now() - llmStart;
    fullText += delta;
  }

  const llmTotal = performance.now() - llmStart;
  console.log(`LLM (${llmModel}): TTFT ${ttft?.toFixed(0)}ms | Total ${llmTotal.toFixed(0)}ms`);
  console.log(`Response: "${fullText.trim().slice(0, 150)}"\n`);

  console.log("--- SUMMARY ---");
  console.log(`  STT:              ${sttTime.toFixed(0)}ms`);
  console.log(`  LLM TTFT:         ${ttft?.toFixed(0)}ms`);
  console.log(`  LLM Total:        ${llmTotal.toFixed(0)}ms`);
  console.log(`  STT + LLM TTFT:   ${(sttTime + (ttft ?? 0)).toFixed(0)}ms  ← time before TTS can start`);
  console.log(`  + TTS (~400ms):   ~${(sttTime + (ttft ?? 0) + 400).toFixed(0)}ms  ← estimated first audio to caller\n`);
}

async function main() {
  await benchSTT();
  await benchLLM();
  await benchE2E();
  console.log("✓ Groq benchmark complete");
}

main().catch(console.error);
