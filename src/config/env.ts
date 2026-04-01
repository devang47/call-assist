import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),

  // Database
  DATABASE_PATH: z.string().default("./data/call-assist.db"),

  // Twilio
  TWILIO_ACCOUNT_SID: z.string().min(1),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_PHONE_NUMBER: z.string().min(1),
  TWILIO_SIGNATURE_VALIDATION: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // Deepgram (TTS)
  DEEPGRAM_API_KEY: z.string().min(1),

  // Groq (STT + LLM)
  GROQ_API_KEY: z.string().min(1),
  GROQ_STT_MODEL: z.string().default("whisper-large-v3-turbo"),
  GROQ_LLM_MODEL: z.string().default("llama-3.3-70b-versatile"),

  // Google Calendar (shared OAuth app credentials)
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REFRESH_TOKEN: z.string().optional(), // Fallback for single-practice mode
  GOOGLE_CALENDAR_ID: z.string().default("primary"), // Fallback for single-practice mode

  // Practice config (fallback for single-practice mode — DB is primary source)
  PRACTICE_NAME: z.string().default("Smile Dental Clinic"),
  PRACTICE_TIMEZONE: z.string().default("America/New_York"),
  PRACTICE_PHONE: z.string().default(""),
  PRACTICE_ADDRESS: z.string().default(""),
  PRACTICE_APPOINTMENT_DURATION_MINUTES: z.coerce.number().default(30),

  // Server
  SERVER_URL: z.string().default("http://localhost:3000"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid environment variables:");
    console.error(result.error.format());
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
