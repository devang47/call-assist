import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

// --- Practices ---

export const practices = sqliteTable("practices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  timezone: text("timezone").notNull().default("America/New_York"),
  phone: text("phone").default(""),
  address: text("address").default(""),
  twilioNumber: text("twilio_number").notNull().unique(),
  staffPhone: text("staff_phone"),
  appointmentDurationMinutes: integer("appointment_duration_minutes").notNull().default(30),
  businessHours: text("business_hours").notNull(), // JSON string
  googleCalendarId: text("google_calendar_id").notNull().default("primary"),
  systemPromptOverride: text("system_prompt_override"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// --- Google OAuth Tokens ---

export const googleOauthTokens = sqliteTable("google_oauth_tokens", {
  id: text("id").primaryKey(),
  practiceId: text("practice_id").notNull().unique().references(() => practices.id),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token").notNull(),
  expiryDate: integer("expiry_date"), // epoch ms
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// --- Call Logs ---

export const callLogs = sqliteTable("call_logs", {
  id: text("id").primaryKey(),
  practiceId: text("practice_id").notNull().references(() => practices.id),
  callSid: text("call_sid").notNull().unique(),
  streamSid: text("stream_sid"),
  callerPhone: text("caller_phone"),
  patientId: text("patient_id").references(() => patients.id),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  durationSeconds: integer("duration_seconds"),
  outcome: text("outcome"), // 'appointment_booked' | 'info_provided' | 'transferred' | 'abandoned' | 'error'
  outcomeDetails: text("outcome_details"), // JSON
  costCents: integer("cost_cents"),
  sttCostCents: integer("stt_cost_cents"),
  llmCostCents: integer("llm_cost_cents"),
  ttsCostCents: integer("tts_cost_cents"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// --- Call Transcripts ---

export const callTranscripts = sqliteTable("call_transcripts", {
  id: text("id").primaryKey(),
  callLogId: text("call_log_id").notNull().references(() => callLogs.id),
  role: text("role").notNull(), // 'user' | 'assistant' | 'tool'
  content: text("content").notNull(),
  toolName: text("tool_name"),
  toolInput: text("tool_input"), // JSON
  toolOutput: text("tool_output"), // JSON
  timestamp: text("timestamp").notNull().$defaultFn(() => new Date().toISOString()),
  sequence: integer("sequence").notNull(),
});

// --- Patients ---

export const patients = sqliteTable(
  "patients",
  {
    id: text("id").primaryKey(),
    practiceId: text("practice_id").notNull().references(() => practices.id),
    phone: text("phone").notNull(),
    name: text("name"),
    notes: text("notes"),
    callCount: integer("call_count").notNull().default(0),
    lastCallAt: text("last_call_at"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [uniqueIndex("patients_practice_phone_idx").on(table.practiceId, table.phone)]
);
