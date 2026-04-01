import { createOpenAI } from "@ai-sdk/openai";
import { streamText, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { env } from "../config/env.js";
import { getSystemPrompt } from "../voice/prompts.js";
import { checkAvailability } from "../scheduling/availability.js";
import { bookAppointment } from "../scheduling/booking.js";

const groq = createOpenAI({
  apiKey: env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const llmTools = {
  check_availability: tool({
    description:
      "Check available appointment slots for a given date. Returns a list of available time slots.",
    inputSchema: z.object({
      date: z.string().describe("The date to check availability for, in YYYY-MM-DD format"),
      service_type: z
        .string()
        .optional()
        .describe("Type of appointment: cleaning, checkup, filling, extraction, root_canal, crown, whitening, consultation, emergency"),
    }),
    execute: async ({ date, service_type }) => {
      return checkAvailability(date, service_type);
    },
  }),

  book_appointment: tool({
    description:
      "Book an appointment slot for the caller. Use after confirming the date, time, and service with the caller.",
    inputSchema: z.object({
      date: z.string().describe("Appointment date in YYYY-MM-DD format"),
      time: z.string().describe("Appointment time in HH:MM 24-hour format (e.g., 14:00)"),
      patient_name: z.string().describe("Full name of the patient"),
      patient_phone: z.string().optional().describe("Phone number of the patient"),
      service_type: z.string().optional().describe("Type of dental service"),
      notes: z.string().optional().describe("Any additional notes about the appointment"),
    }),
    execute: async ({ date, time, patient_name, patient_phone, service_type, notes }) => {
      return bookAppointment({
        date,
        time,
        patientName: patient_name,
        patientPhone: patient_phone,
        serviceType: service_type,
        notes,
      });
    },
  }),

  get_practice_info: tool({
    description:
      "Get practice information such as address, business hours, services offered, or insurance details.",
    inputSchema: z.object({
      query: z
        .string()
        .describe("What the caller wants to know: hours, address, services, insurance, pricing, parking"),
    }),
    execute: async ({ query }) => {
      return {
        name: env.PRACTICE_NAME,
        address: env.PRACTICE_ADDRESS || "Address not configured",
        phone: env.PRACTICE_PHONE || env.TWILIO_PHONE_NUMBER,
        timezone: env.PRACTICE_TIMEZONE,
        business_hours: {
          monday: "9:00 AM - 5:00 PM",
          tuesday: "9:00 AM - 5:00 PM",
          wednesday: "9:00 AM - 5:00 PM",
          thursday: "9:00 AM - 5:00 PM",
          friday: "9:00 AM - 5:00 PM",
          saturday: "9:00 AM - 1:00 PM",
          sunday: "Closed",
        },
        services: [
          "Regular cleaning", "Deep cleaning", "Dental checkup", "Fillings",
          "Tooth extraction", "Root canal", "Dental crowns", "Teeth whitening",
          "Consultation", "Emergency dental care",
        ],
        appointment_duration_minutes: env.PRACTICE_APPOINTMENT_DURATION_MINUTES,
      };
    },
  }),
};

export interface StreamingLLMResponse {
  textStream: AsyncIterable<string>;
  text: PromiseLike<string>;
  abort: () => void;
}

export async function generateResponse(
  conversationHistory: ModelMessage[],
  abortSignal?: AbortSignal
): Promise<StreamingLLMResponse> {
  const abortController = new AbortController();

  if (abortSignal) {
    abortSignal.addEventListener("abort", () => abortController.abort());
  }

  const result = streamText({
    model: groq.chat(env.GROQ_LLM_MODEL),
    system: getSystemPrompt(),
    messages: conversationHistory,
    tools: llmTools,
    temperature: 0.7,
    maxOutputTokens: 512, // Phone responses should be short
    abortSignal: abortController.signal,
  });

  return {
    textStream: result.textStream,
    text: result.text,
    abort: () => abortController.abort(),
  };
}
