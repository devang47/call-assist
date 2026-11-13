import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";

vi.mock("../config/env.js", () => ({
  env: {
    DEEPGRAM_API_KEY: "test",
    DEEPGRAM_STT_MODEL: "flux-general-multi",
    FLUX_LANGUAGE_HINTS: ["en", "hi"],
    FLUX_EOT_THRESHOLD: 0.7,
    FLUX_EAGER_EOT_THRESHOLD: 0.5,
    FLUX_EOT_TIMEOUT_MS: 5000,
  },
}));

const sockets: FakeSocket[] = [];
class FakeSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 0;
  sent: Array<Buffer | string> = [];
  constructor(public url: string) {
    super();
    sockets.push(this);
  }
  send(data: Buffer | string) {
    this.sent.push(data);
  }
  close() {}
  open() {
    this.readyState = 1;
    this.emit("open");
  }
}
vi.mock("ws", () => ({ default: FakeSocket }));

const { FluxSTT } = await import("./flux-stt.js");

describe("FluxSTT", () => {
  it("connects with turn-detection and language params", () => {
    new FluxSTT().start();
    const url = new URL(sockets.at(-1)!.url);
    expect(url.pathname).toBe("/v2/listen");
    expect(url.searchParams.get("encoding")).toBe("linear16");
    expect(url.searchParams.get("sample_rate")).toBe("8000");
    expect(url.searchParams.get("eager_eot_threshold")).toBe("0.5");
    expect(url.searchParams.getAll("language_hint")).toEqual(["en", "hi"]);
  });

  it("buffers until open, then sends 80ms linear16 chunks", () => {
    const flux = new FluxSTT();
    flux.start();
    const ws = sockets.at(-1)!;
    const frame = Buffer.alloc(160, 0xff); // 20ms of mulaw silence
    flux.sendMulaw(frame);
    expect(ws.sent).toHaveLength(0);
    ws.open();
    for (let i = 0; i < 3; i++) flux.sendMulaw(frame);
    expect(ws.sent).toHaveLength(1);
    const chunk = ws.sent[0] as Buffer;
    expect(chunk.length).toBe(1280); // 4 frames × 160 samples × 2 bytes
    expect(chunk.readInt16LE(0)).toBe(0); // mulaw 0xff decodes to 0
  });

  it("emits turn events but not Update or binary", () => {
    const flux = new FluxSTT();
    flux.start();
    const ws = sockets.at(-1)!;
    const events: string[] = [];
    flux.on("turn", (t) => events.push(`${t.event}:${t.transcript}`));
    const msg = (event: string, transcript: string) =>
      ws.emit("message", Buffer.from(JSON.stringify({ type: "TurnInfo", event, transcript })), false);
    msg("StartOfTurn", "hi");
    msg("Update", "hi there");
    msg("EagerEndOfTurn", "hi there");
    msg("EndOfTurn", "hi there");
    ws.emit("message", Buffer.alloc(4), true);
    expect(events).toEqual(["StartOfTurn:hi", "EagerEndOfTurn:hi there", "EndOfTurn:hi there"]);
  });
});
