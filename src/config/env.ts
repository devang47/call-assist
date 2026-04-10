import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),

  // Database
  DATABASE_PATH: z.string().default("./data/call-assist.db"),
  CALL_LOG_DIR: z.string().default("./storage/call-logs"),

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
  DEEPGRAM_TTS_MODEL: z.string().default("aura-2-thalia-en"),

  // Groq (STT + LLM)
  GROQ_API_KEY: z.string().min(1),
  GROQ_STT_MODEL: z.string().default("whisper-large-v3-turbo"),
  GROQ_LLM_MODEL: z.string().default("llama-3.3-70b-versatile"),
  GROQ_LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3),
  GROQ_LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(80),
  GROQ_LLM_MAX_STEPS: z.coerce.number().int().min(2).max(8).default(4),

  // Voice tuning
  SILENCE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  VAD_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
  VAD_MIN_SPEECH_DURATION_S: z.coerce.number().positive().default(0.2),
  VAD_MIN_SILENCE_DURATION_S: z.coerce.number().positive().default(0.65),
  AVAILABILITY_RESULT_LIMIT: z.coerce.number().int().positive().default(6),

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
