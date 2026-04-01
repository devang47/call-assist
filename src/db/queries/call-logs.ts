import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../index.js";
import { callLogs } from "../schema.js";

export function createCallLog(params: {
  practiceId: string;
  callSid: string;
  callerPhone: string;
  patientId?: string;
}) {
  const id = nanoid();
  db.insert(callLogs)
    .values({
      id,
      practiceId: params.practiceId,
      callSid: params.callSid,
      callerPhone: params.callerPhone,
      patientId: params.patientId || null,
      startedAt: new Date().toISOString(),
    })
    .run();
  return id;
}

export function updateCallLog(
  callSid: string,
  data: {
    streamSid?: string;
    endedAt?: string;
    durationSeconds?: number;
    outcome?: string;
    outcomeDetails?: Record<string, unknown>;
    costCents?: number;
    patientId?: string;
  }
) {
  db.update(callLogs)
    .set({
      ...(data.streamSid !== undefined && { streamSid: data.streamSid }),
      ...(data.endedAt !== undefined && { endedAt: data.endedAt }),
      ...(data.durationSeconds !== undefined && { durationSeconds: data.durationSeconds }),
      ...(data.outcome !== undefined && { outcome: data.outcome }),
      ...(data.outcomeDetails !== undefined && {
        outcomeDetails: JSON.stringify(data.outcomeDetails),
      }),
      ...(data.costCents !== undefined && { costCents: data.costCents }),
      ...(data.patientId !== undefined && { patientId: data.patientId }),
    })
    .where(eq(callLogs.callSid, callSid))
    .run();
}

export function getCallLogByCallSid(callSid: string) {
  return db.select().from(callLogs).where(eq(callLogs.callSid, callSid)).get();
}
