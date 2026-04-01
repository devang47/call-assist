import { eq, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../index.js";
import { patients } from "../schema.js";

export function findOrCreatePatient(practiceId: string, phone: string): string {
  const existing = db
    .select()
    .from(patients)
    .where(and(eq(patients.practiceId, practiceId), eq(patients.phone, phone)))
    .get();

  if (existing) {
    // Increment call count and update last_call_at
    db.update(patients)
      .set({
        callCount: sql`${patients.callCount} + 1`,
        lastCallAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(patients.id, existing.id))
      .run();
    return existing.id;
  }

  const id = nanoid();
  db.insert(patients)
    .values({
      id,
      practiceId,
      phone,
      callCount: 1,
      lastCallAt: new Date().toISOString(),
    })
    .run();
  return id;
}

export function updatePatientName(patientId: string, name: string) {
  db.update(patients)
    .set({ name, updatedAt: new Date().toISOString() })
    .where(eq(patients.id, patientId))
    .run();
}

export function getPatientByPhone(practiceId: string, phone: string) {
  return db
    .select()
    .from(patients)
    .where(and(eq(patients.practiceId, practiceId), eq(patients.phone, phone)))
    .get();
}
