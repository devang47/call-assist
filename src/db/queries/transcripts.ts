import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../index.js";
import { callTranscripts } from "../schema.js";

export function appendTranscriptTurn(params: {
  callLogId: string;
  role: string;
  content: string;
  sequence: number;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
}) {
  db.insert(callTranscripts)
    .values({
      id: nanoid(),
      callLogId: params.callLogId,
      role: params.role,
      content: params.content,
      sequence: params.sequence,
      toolName: params.toolName || null,
      toolInput: params.toolInput ? JSON.stringify(params.toolInput) : null,
      toolOutput: params.toolOutput ? JSON.stringify(params.toolOutput) : null,
    })
    .run();
}

export function getTranscriptByCallLogId(callLogId: string) {
  return db
    .select()
    .from(callTranscripts)
    .where(eq(callTranscripts.callLogId, callLogId))
    .orderBy(callTranscripts.sequence)
    .all();
}
