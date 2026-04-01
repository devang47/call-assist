import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),

  // Twilio
  TWILIO_ACCOUNT_SID: z.string().min(1),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_PHONE_NUMBER: z.string().min(1),

  // Deepgram (TTS)
  DEEPGRAM_API_KEY: z.string().min(1),

  // Groq (STT + LLM)
  GROQ_API_KEY: z.string().min(1),
  GROQ_STT_MODEL: z.string().default("whisper-large-v3-turbo"),
  GROQ_LLM_MODEL: z.string().default("meta-llama/llama-4-scout-17b-16e-instruct"),

  // Google Calendar
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REFRESH_TOKEN: z.string().optional(), // Optional — obtained via OAuth flow
  GOOGLE_CALENDAR_ID: z.string().default("primary"),

  // Practice config (hardcoded for MVP)
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
