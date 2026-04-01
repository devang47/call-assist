/**
 * Benchmark: Deepgram STT latency
 * Measures time from sending audio to receiving first transcript
 */
import "dotenv/config";
import WebSocket from "ws";

const API_KEY = process.env.DEEPGRAM_API_KEY!;

async function benchSTT() {
  const params = new URLSearchParams({
    model: "nova-3",
    encoding: "mulaw",
    sample_rate: "8000",
    channels: "1",
    punctuate: "true",
    interim_results: "true",
    endpointing: "300",
    vad_events: "true",
  });

  console.log("=== Deepgram STT Latency Benchmark ===\n");

  // Measure connection time
  const connStart = performance.now();

  const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
    headers: { Authorization: `Token ${API_KEY}` },
  });

  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => {
      const connTime = performance.now() - connStart;
      console.log(`Connection time: ${connTime.toFixed(0)}ms`);
      resolve();
    });
    ws.on("error", reject);
  });

  // Generate a short burst of silence (mulaw silence = 0xFF bytes)
  // then a tone pattern to trigger speech detection
  const silenceChunk = Buffer.alloc(160, 0xff); // 20ms of silence at 8kHz mulaw
  const toneChunk = Buffer.alloc(160); // 20ms of "audio"
  for (let i = 0; i < toneChunk.length; i++) {
    toneChunk[i] = Math.floor(Math.random() * 128) + 64; // random mulaw audio
  }

  let firstTranscriptTime: number | null = null;
  let firstInterimTime: number | null = null;
  const audioSendStart = performance.now();

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    const now = performance.now();

    if (msg.type === "Results") {
      const transcript = msg.channel?.alternatives?.[0]?.transcript || "";
      const isFinal = msg.is_final;

      if (!firstInterimTime && transcript) {
        firstInterimTime = now - audioSendStart;
        console.log(`First interim transcript: ${firstInterimTime.toFixed(0)}ms — "${transcript}"`);
      }
      if (!firstTranscriptTime && isFinal && transcript) {
        firstTranscriptTime = now - audioSendStart;
        console.log(`First final transcript:  ${firstTranscriptTime.toFixed(0)}ms — "${transcript}"`);
      }
    }

    if (msg.type === "SpeechStarted") {
      console.log(`SpeechStarted event:    ${(now - audioSendStart).toFixed(0)}ms`);
    }

    if (msg.type === "UtteranceEnd") {
      console.log(`UtteranceEnd event:     ${(now - audioSendStart).toFixed(0)}ms`);
    }
  });

  // Send 2 seconds of "audio" data in 20ms chunks
  for (let i = 0; i < 100; i++) {
    ws.send(i < 5 ? silenceChunk : toneChunk);
    await sleep(20);
  }

  // Send silence to trigger endpointing
  for (let i = 0; i < 50; i++) {
    ws.send(silenceChunk);
    await sleep(20);
  }

  // Wait for results
  await sleep(3000);

  console.log(`\nTotal audio sent: ~3s`);
  if (!firstInterimTime) console.log("No transcripts received (expected with synthetic audio)");

  ws.close();
  console.log("\n✓ STT benchmark complete");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

benchSTT().catch(console.error);
