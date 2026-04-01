import { eq } from "drizzle-orm";
import { db } from "./index.js";
import { practices } from "./schema.js";
import { env } from "../config/env.js";

export interface PracticeContext {
  id: string;
  name: string;
  timezone: string;
  phone: string;
  address: string;
  staffPhone: string | null;
  appointmentDurationMinutes: number;
  businessHours: Record<number, { open: string; close: string } | null>;
  googleCalendarId: string;
  systemPromptOverride: string | null;
  twilioNumber: string;
}

function rowToContext(row: typeof practices.$inferSelect): PracticeContext {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    phone: row.phone || "",
    address: row.address || "",
    staffPhone: row.staffPhone,
    appointmentDurationMinutes: row.appointmentDurationMinutes,
    businessHours: JSON.parse(row.businessHours),
    googleCalendarId: row.googleCalendarId,
    systemPromptOverride: row.systemPromptOverride,
    twilioNumber: row.twilioNumber,
  };
}

// In-memory cache: twilio number -> { context, expiresAt }
const cache = new Map<string, { ctx: PracticeContext; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function loadPracticeByTwilioNumber(twilioNumber: string): PracticeContext | null {
  const cached = cache.get(twilioNumber);
  if (cached && cached.expiresAt > Date.now()) return cached.ctx;

  const row = db
    .select()
    .from(practices)
    .where(eq(practices.twilioNumber, twilioNumber))
    .get();

  if (!row || !row.active) return null;

  const ctx = rowToContext(row);
  cache.set(twilioNumber, { ctx, expiresAt: Date.now() + CACHE_TTL_MS });
  return ctx;
}

export function loadPracticeById(id: string): PracticeContext | null {
  const row = db.select().from(practices).where(eq(practices.id, id)).get();
  if (!row || !row.active) return null;
  return rowToContext(row);
}

/** Fallback PracticeContext from env vars (for backward compatibility) */
export function getFallbackPracticeContext(): PracticeContext {
  return {
    id: "__env_fallback__",
    name: env.PRACTICE_NAME,
    timezone: env.PRACTICE_TIMEZONE,
    phone: env.PRACTICE_PHONE,
    address: env.PRACTICE_ADDRESS,
    staffPhone: null,
    appointmentDurationMinutes: env.PRACTICE_APPOINTMENT_DURATION_MINUTES,
    businessHours: {
      0: null,
      1: { open: "09:00", close: "17:00" },
      2: { open: "09:00", close: "17:00" },
      3: { open: "09:00", close: "17:00" },
      4: { open: "09:00", close: "17:00" },
      5: { open: "09:00", close: "17:00" },
      6: { open: "09:00", close: "13:00" },
    },
    googleCalendarId: env.GOOGLE_CALENDAR_ID,
    systemPromptOverride: null,
    twilioNumber: env.TWILIO_PHONE_NUMBER,
  };
}
