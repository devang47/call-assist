/**
 * One caller turn, end of speech → first audio sent to Twilio, in ms.
 * Logged as a "turn_latency" event in the per-call JSONL (storage/call-logs).
 */
export interface TurnLatency {
  stt: "flux" | "whisper";
  /** Caller stopped talking → we decided the turn was over (VAD silence window / Flux EOT). */
  endpointMs: number;
  /** Whisper only: batch transcription time. */
  sttMs?: number;
  /** Turn detected → first LLM token. Negative-ish/small when an eager draft was already running. */
  llmTtftMs?: number;
  /** Caller stopped talking → first audio byte to Twilio. The number callers feel (minus network). */
  totalMs: number;
  /** An eager end-of-turn draft was reused. */
  speculative: boolean;
  /** First audio was a tool hold message ("Let me check that"), not the answer. */
  holdMessage: boolean;
}

/** Nearest-rank percentile; p in [0, 100]. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function summarize(values: number[]) {
  return {
    n: values.length,
    p50: percentile(values, 50),
    p90: percentile(values, 90),
    p99: percentile(values, 99),
  };
}
