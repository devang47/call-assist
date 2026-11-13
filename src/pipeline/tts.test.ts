import { describe, expect, it, vi } from "vitest";

vi.mock("../config/env.js", () => ({
  env: { DEEPGRAM_TTS_MODEL: "aura-2-test", DEEPGRAM_API_KEY: "test" },
}));
const cache = new Map<string, string[]>();
vi.mock("./tts-cache.js", () => ({
  getCachedAudio: (text: string) => cache.get(text) ?? null,
  setCachedAudio: (text: string, chunks: string[]) => cache.set(text, chunks),
}));
const { DeepgramTTS } = await import("./tts.js");

/** A DeepgramTTS whose socket is a stub; returns helpers to fake server messages. */
function setup() {
  const tts = new DeepgramTTS();
  const sent: Array<{ type: string; text?: string }> = [];
  const t = tts as any;
  t.ws = { send: (raw: string) => sent.push(JSON.parse(raw)) };
  t.isOpen = true;
  const out: string[] = [];
  tts.on("audio", (b64: string) => out.push(b64));
  tts.on("flushed", () => out.push("<flushed>"));
  return {
    tts,
    sent,
    out,
    audio: (b64: string) => t.handleAudio(b64),
    control: (type: string) => t.handleControl({ type }),
    tick: () => new Promise((r) => process.nextTick(r)),
  };
}

describe("DeepgramTTS queue", () => {
  it("plays a cached phrase only after earlier Deepgram audio finishes", async () => {
    cache.set("Let me check that for you.", ["CACHED"]);
    const { tts, out, audio, control, tick } = setup();

    tts.speak("Sure, one second.");
    tts.speak("Let me check that for you.", { cache: true });
    tts.speak("Tuesday works.");
    expect(out).toEqual([]); // cached audio must not jump the queue

    audio("A1");
    control("Flushed");
    await tick();
    audio("C1");
    control("Flushed");
    await tick();

    expect(out).toEqual(["A1", "<flushed>", "CACHED", "<flushed>", "C1", "<flushed>"]);
  });

  it("caches each fixed phrase under its own text", () => {
    cache.clear();
    const { tts, audio, control } = setup();

    tts.speak("Hello there.", { cache: true });
    tts.speak("Dynamic LLM text.");
    audio("H1");
    audio("H2");
    control("Flushed");
    audio("D1");
    control("Flushed");

    expect(cache.get("Hello there.")).toEqual(["H1", "H2"]);
    expect(cache.has("Dynamic LLM text.")).toBe(false);
  });

  it("drops stale audio after clear until Deepgram confirms", () => {
    const { tts, sent, out, audio, control } = setup();

    tts.speak("Long answer being interrupted.");
    audio("OLD1");
    tts.clear();
    audio("OLD2");
    control("Flushed");
    control("Cleared");
    tts.speak("New answer.");
    audio("NEW1");

    expect(sent.at(-3)?.type).toBe("Clear");
    expect(out).toEqual(["OLD1", "NEW1"]);
  });
});
