import path from "node:path";
import { appendFile, mkdir } from "node:fs/promises";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../config/env.js";

export interface CallDebugContext {
  callSid: string;
  callLogId?: string;
  callerPhone?: string;
  practiceId?: string;
  practiceName?: string;
  streamSid?: string;
}

export interface CallDebugEntry {
  ts: string;
  event: string;
  callSid: string;
  callLogId?: string;
  callerPhone?: string;
  practiceId?: string;
  practiceName?: string;
  streamSid?: string;
  data?: Record<string, unknown>;
}

export interface CallEventLogger {
  logEvent: (event: string, data?: Record<string, unknown>, timestamp?: string) => void;
}

const ensuredDirectories = new Map<string, Promise<void>>();

function ensureDirectory(dirPath: string): Promise<void> {
  const existing = ensuredDirectories.get(dirPath);
  if (existing) {
    return existing;
  }

  const created = mkdir(dirPath, { recursive: true }).then(() => undefined);
  ensuredDirectories.set(dirPath, created);
  return created;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function getDateSegment(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function getCallDebugLogPath(callSid: string, timestamp: string): string {
  const dateDir = path.resolve(env.CALL_LOG_DIR, getDateSegment(timestamp));
  return path.join(dateDir, `${sanitizeSegment(callSid)}.jsonl`);
}

export class FileCallDebugLogger implements CallEventLogger {
  private context: CallDebugContext;
  private filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    initialContext: CallDebugContext,
    private readonly appLogger?: Pick<FastifyBaseLogger, "error">
  ) {
    this.context = { ...initialContext };
    this.filePath = getCallDebugLogPath(initialContext.callSid, new Date().toISOString());
    this.logEvent("call_log_opened", { filePath: this.filePath });
  }

  get path(): string {
    return this.filePath;
  }

  setContext(patch: Partial<CallDebugContext>): void {
    this.context = { ...this.context, ...patch };
    this.logEvent("call_context_updated", patch as Record<string, unknown>);
  }

  logEvent(event: string, data?: Record<string, unknown>, timestamp = new Date().toISOString()): void {
    const entry: CallDebugEntry = {
      ts: timestamp,
      event,
      callSid: this.context.callSid,
      ...(this.context.callLogId && { callLogId: this.context.callLogId }),
      ...(this.context.callerPhone && { callerPhone: this.context.callerPhone }),
      ...(this.context.practiceId && { practiceId: this.context.practiceId }),
      ...(this.context.practiceName && { practiceName: this.context.practiceName }),
      ...(this.context.streamSid && { streamSid: this.context.streamSid }),
      ...(data && Object.keys(data).length > 0 && { data }),
    };

    const line = `${JSON.stringify(entry)}\n`;
    this.writeQueue = this.writeQueue
      .then(async () => {
        const dirPath = path.dirname(this.filePath);
        await ensureDirectory(dirPath);
        await appendFile(this.filePath, line, "utf8");
      })
      .catch((err) => {
        this.appLogger?.error({ err, event, filePath: this.filePath }, "Failed to write call debug log");
      });
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.logEvent("call_log_closed");
  }
}

export function createCallDebugLogger(
  context: CallDebugContext,
  appLogger?: Pick<FastifyBaseLogger, "error">
): FileCallDebugLogger {
  return new FileCallDebugLogger(context, appLogger);
}
