import { env } from "../config/env.js";

/** True once Langfuse is wired up; streamText only emits spans when this is set. */
export let telemetryEnabled = false;

/**
 * Send AI SDK spans (prompt, tool calls, token usage, latency) to Langfuse.
 * The Langfuse SDK reads LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL.
 */
export async function initTelemetry(): Promise<void> {
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return;
  const [{ LangfuseSpanProcessor }, { NodeTracerProvider }] = await Promise.all([
    import("@langfuse/otel"),
    import("@opentelemetry/sdk-trace-node"),
  ]);
  const processor = new LangfuseSpanProcessor();
  new NodeTracerProvider({ spanProcessors: [processor] }).register();
  telemetryEnabled = true;

  // Batched spans are lost if the process exits without flushing.
  const flush = () => void processor.forceFlush().finally(() => process.exit(0));
  process.once("SIGINT", flush);
  process.once("SIGTERM", flush);
}
