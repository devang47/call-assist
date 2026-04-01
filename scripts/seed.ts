import "dotenv/config";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { nanoid } from "nanoid";
import * as schema from "../src/db/schema.js";

const dbPath = process.env.DATABASE_PATH || "./data/call-assist.db";
const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
const db = drizzle(sqlite, { schema });

const DEFAULT_BUSINESS_HOURS: Record<number, { open: string; close: string } | null> = {
  0: null, // Sunday
  1: { open: "09:00", close: "17:00" },
  2: { open: "09:00", close: "17:00" },
  3: { open: "09:00", close: "17:00" },
  4: { open: "09:00", close: "17:00" },
  5: { open: "09:00", close: "17:00" },
  6: { open: "09:00", close: "13:00" }, // Saturday half day
};

const practiceId = nanoid();
const name = process.env.PRACTICE_NAME || "Smile Dental Clinic";

db.insert(schema.practices)
  .values({
    id: practiceId,
    name,
    slug: name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""),
    timezone: process.env.PRACTICE_TIMEZONE || "America/New_York",
    phone: process.env.PRACTICE_PHONE || "",
    address: process.env.PRACTICE_ADDRESS || "",
    twilioNumber: process.env.TWILIO_PHONE_NUMBER || "",
    staffPhone: null,
    appointmentDurationMinutes: Number(process.env.PRACTICE_APPOINTMENT_DURATION_MINUTES) || 30,
    businessHours: JSON.stringify(DEFAULT_BUSINESS_HOURS),
    googleCalendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
    active: true,
  })
  .run();

console.log(`Seeded practice: "${name}" (id: ${practiceId})`);

// If there's a Google refresh token in env, seed it too
if (process.env.GOOGLE_REFRESH_TOKEN) {
  db.insert(schema.googleOauthTokens)
    .values({
      id: nanoid(),
      practiceId,
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
      accessToken: null,
      expiryDate: null,
    })
    .run();
  console.log("Seeded Google OAuth token from env");
}

sqlite.close();
console.log("Done!");
