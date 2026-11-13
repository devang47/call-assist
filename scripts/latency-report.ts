/**
 * Per-turn latency from real calls: reads the "turn_latency" events the voice
 * pipeline writes to storage/call-logs/<date>/<callSid>.jsonl and prints
 * p50/p90/p99 per STT provider, as a markdown table ready for the README.
 *
 *   pnpm latency:report                 # all logs
 *   pnpm latency:report 2026-11-13      # one day (or any path under CALL_LOG_DIR)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { summarize, type TurnLatency } from "../src/lib/latency.js";

const root = path.resolve(process.env.CALL_LOG_DIR || "./storage/call-logs", process.argv[2] ?? "");

function jsonlFiles(dir: string): string[] {
  if (statSync(dir).isFile()) return [dir];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? jsonlFiles(full) : name.endsWith(".jsonl") ? [full] : [];
  });
}

const turns: TurnLatency[] = [];
let calls = 0;
for (const file of jsonlFiles(root)) {
  let found = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"turn_latency"')) continue;
    const entry = JSON.parse(line);
    if (entry.event !== "turn_latency") continue;
    turns.push(entry.data);
    found = true;
  }
  if (found) calls++;
}

if (turns.length === 0) {
  console.log(`No turn_latency events under ${root}. Make a call first.`);
  process.exit(0);
}

const fmt = (n: number) => (Number.isNaN(n) ? "–" : `${Math.round(n)}`);
const row = (label: string, values: number[]) => {
  const s = summarize(values);
  return `| ${label} | ${s.n} | ${fmt(s.p50)} | ${fmt(s.p90)} | ${fmt(s.p99)} |`;
};

console.log(`${turns.length} turns from ${calls} calls (${root})\n`);
console.log("| Stage (ms) | n | p50 | p90 | p99 |");
console.log("|---|---|---|---|---|");
for (const stt of ["flux", "whisper"] as const) {
  const t = turns.filter((x) => x.stt === stt);
  if (t.length === 0) continue;
  const answered = t.filter((x) => !x.holdMessage);
  console.log(row(`**${stt}: end of speech → first audio**`, t.map((x) => x.totalMs)));
  console.log(row(`${stt}: same, answer turns only (no hold message)`, answered.map((x) => x.totalMs)));
  console.log(row(`${stt}: endpointing (speech end → turn detected)`, t.map((x) => x.endpointMs)));
  if (stt === "whisper") console.log(row("whisper: batch STT", t.flatMap((x) => (x.sttMs === undefined ? [] : [x.sttMs]))));
  console.log(row(`${stt}: turn detected → first LLM token`, t.flatMap((x) => (x.llmTtftMs === undefined ? [] : [x.llmTtftMs]))));
  const spec = t.filter((x) => x.speculative);
  if (spec.length) console.log(row(`${stt}: eager-draft turns (${Math.round((100 * spec.length) / t.length)}%)`, spec.map((x) => x.totalMs)));
}
