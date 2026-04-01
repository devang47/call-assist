/**
 * Benchmark: Deepgram TTS latency
 * Measures time from sending text to receiving first audio byte
 */
import "dotenv/config";
import WebSocket from "ws";

const API_KEY = process.env.DEEPGRAM_API_KEY!;

async function benchTTS() {
  const params = new URLSearchParams({
    model: "aura-2-thalia-en",
    encoding: "mulaw",
    sample_rate: "8000",
  });

  console.log("=== Deepgram TTS Latency Benchmark ===\n");

  const testPhrases = [
    "Hello, how can I help you today?",
    "I have openings at ten AM, two PM, and four PM on Monday. Which works best for you?",
    "Great, you're booked for Monday March 30th at 2 PM for a cleaning. Is there anything else I can help with?",
  ];

  // Measure connection time
  const connStart = performance.now();

  const ws = new WebSocket(`wss://api.deepgram.com/v1/speak?${params}`, {
    headers: { Authorization: `Token ${API_KEY}` },
  });

  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => {
      const connTime = performance.now() - connStart;
      console.log(`Connection time: ${connTime.toFixed(0)}ms\n`);
      resolve();
    });
    ws.on("error", reject);
  });

  for (const phrase of testPhrases) {
    await benchPhrase(ws, phrase);
  }

  ws.close();
  console.log("✓ TTS benchmark complete");
}

async function benchPhrase(ws: WebSocket, text: string) {
  return new Promise<void>((resolve) => {
    let firstByteTime: number | null = null;
    let totalBytes = 0;
    let chunkCount = 0;
    let flushed = false;

    const sendTime = performance.now();

    const handler = (data: Buffer, isBinary: boolean) => {
      const now = performance.now();

      if (isBinary) {
        if (!firstByteTime) {
          firstByteTime = now - sendTime;
        }
        totalBytes += data.length;
        chunkCount++;
      } else {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "Flushed") {
            flushed = true;
            const totalTime = now - sendTime;
            console.log(`  "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"`);
            console.log(`  First audio byte: ${firstByteTime?.toFixed(0) ?? "N/A"}ms`);
            console.log(`  Total time:       ${totalTime.toFixed(0)}ms`);
            console.log(`  Audio chunks:     ${chunkCount} (${(totalBytes / 1024).toFixed(1)} KB)`);
            console.log(`  Audio duration:   ~${(totalBytes / 8000).toFixed(1)}s (8kHz mulaw)\n`);
            ws.off("message", handler);
            resolve();
          }
        } catch {}
      }
    };

    ws.on("message", handler);
    ws.send(JSON.stringify({ type: "Speak", text }));
    ws.send(JSON.stringify({ type: "Flush" }));

    // Timeout fallback
    setTimeout(() => {
      if (!flushed) {
        console.log(`  TIMEOUT for: "${text.slice(0, 40)}..."\n`);
        ws.off("message", handler);
        resolve();
      }
    }, 10000);
  });
}

benchTTS().catch(console.error);
