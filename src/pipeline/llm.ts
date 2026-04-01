import { createOpenAI } from "@ai-sdk/openai";
import { streamText, tool, stepCountIs, type ModelMessage } from "ai";
import { z } from "zod";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../config/env.js";
import { getSystemPrompt } from "../voice/prompts.js";
import { checkAvailability } from "../scheduling/availability.js";
import { bookAppointment } from "../scheduling/booking.js";
import type { PracticeContext } from "../db/practice-context.js";

const groq = createOpenAI({
  apiKey: env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

export interface ToolCallbacks {
  onOutcome: (outcome: string, details?: Record<string, unknown>) => void;
  onTransfer: (staffPhone: string, reason: string) => void;
  onEndCall: (reason: string) => void;
  /** Called before a tool executes — use to send "hold on" TTS messages */
  onToolStart: (toolName: string) => void;
  /** Called after a successful booking — use to send SMS confirmation */
  onBookingComplete: (details: { date: string; time: string; patientName: string; service?: string }) => void;
}

function createTools(ctx: PracticeContext, callbacks: ToolCallbacks, log: FastifyBaseLogger) {
  return {
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
        log.info({ tool: "check_availability", date, service_type }, "Tool called");
        callbacks.onToolStart("check_availability");
        const result = await checkAvailability(date, service_type, ctx);
        log.info({ tool: "check_availability", available: result.available, slots: result.slots.length }, "Tool result");
        return result;
      },
    }),

    book_appointment: tool({
      description:
        "Book an appointment slot for the caller. Use ONLY after the caller explicitly confirms the date, time, and says yes.",
      inputSchema: z.object({
        date: z.string().describe("Appointment date in YYYY-MM-DD format"),
        time: z.string().describe("Appointment time in HH:MM 24-hour format (e.g., 14:00)"),
        patient_name: z.string().describe("Full name of the patient as they stated it"),
        patient_phone: z.string().optional().describe("Phone number of the patient"),
        service_type: z.string().optional().describe("Type of dental service"),
        notes: z.string().optional().describe("Any additional notes about the appointment"),
      }),
      execute: async ({ date, time, patient_name, patient_phone, service_type, notes }) => {
        log.info({ tool: "book_appointment", date, time, patient_name, service_type }, "Tool called");

        // Reject if name is missing or placeholder
        const invalidNames = ["not provided", "unknown", "n/a", "caller", "patient", ""];
        if (invalidNames.includes(patient_name.toLowerCase().trim())) {
          log.warn({ patient_name }, "Booking rejected — invalid patient name");
          return {
            success: false,
            message: "You need to ask the caller for their name before booking.",
          };
        }

        callbacks.onToolStart("book_appointment");
        const result = await bookAppointment(
          {
            date,
            time,
            patientName: patient_name,
            patientPhone: patient_phone,
            serviceType: service_type,
            notes,
          },
          ctx
        );
        log.info({ tool: "book_appointment", success: result.success, appointmentId: result.appointmentId }, "Tool result");
        if (result.success) {
          callbacks.onOutcome("appointment_booked", {
            appointmentId: result.appointmentId,
            service: result.service,
          });
          callbacks.onBookingComplete({
            date,
            time,
            patientName: patient_name,
            service: service_type,
          });
        }
        return result;
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
        log.info({ tool: "get_practice_info", query }, "Tool called");
        const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
        const hours: Record<string, string> = {};
        for (let d = 0; d < 7; d++) {
          const h = ctx.businessHours[d];
          hours[DAY_NAMES[d]] = h ? `${h.open} - ${h.close}` : "Closed";
        }
        callbacks.onOutcome("info_provided");
        return {
          name: ctx.name,
          address: ctx.address || "Address not configured",
          phone: ctx.phone || ctx.twilioNumber,
          timezone: ctx.timezone,
          business_hours: hours,
          services: [
            "Regular cleaning", "Deep cleaning", "Dental checkup", "Fillings",
            "Tooth extraction", "Root canal", "Dental crowns", "Teeth whitening",
            "Consultation", "Emergency dental care",
          ],
          appointment_duration_minutes: ctx.appointmentDurationMinutes,
        };
      },
    }),

    transfer_to_human: tool({
      description:
        "Transfer the caller to a human staff member. Use ONLY when the caller explicitly and clearly asks to speak to a real person.",
      inputSchema: z.object({
        reason: z.string().describe("Brief reason for the transfer"),
      }),
      execute: async ({ reason }) => {
        log.info({ tool: "transfer_to_human", reason }, "Tool called");
        if (!ctx.staffPhone) {
          log.warn({ tool: "transfer_to_human" }, "No staff phone configured");
          return {
            transfer: false,
            message:
              "No staff number is configured right now. Please take the caller's name and phone number so someone can call them back.",
          };
        }
        callbacks.onTransfer(ctx.staffPhone, reason);
        return { transfer: true, reason };
      },
    }),

    end_call: tool({
      description:
        "End the call gracefully. Use ONLY after you have said your final goodbye message out loud. The goodbye MUST be in your text response, not just a tool call.",
      inputSchema: z.object({
        reason: z.string().describe("Why the call is ending: 'completed', 'goodbye'"),
      }),
      execute: async ({ reason }) => {
        log.info({ tool: "end_call", reason }, "Tool called");
        callbacks.onEndCall(reason);
        return { hangup: true, reason };
      },
    }),
  };
}

export interface StreamingLLMResponse {
  textStream: AsyncIterable<string>;
  text: PromiseLike<string>;
  abort: () => void;
}

export async function generateResponse(
  conversationHistory: ModelMessage[],
  abortSignal: AbortSignal | undefined,
  ctx: PracticeContext,
  callbacks: ToolCallbacks,
  log: FastifyBaseLogger
): Promise<StreamingLLMResponse> {
  const abortController = new AbortController();

  if (abortSignal) {
    abortSignal.addEventListener("abort", () => abortController.abort());
  }

  const tools = createTools(ctx, callbacks, log);

  let hasToolError = false;

  const result = streamText({
    model: groq.chat(env.GROQ_LLM_MODEL),
    system: getSystemPrompt(ctx),
    messages: conversationHistory,
    tools,
    stopWhen: stepCountIs(5),
    temperature: 0.7,
    maxOutputTokens: 150,
    abortSignal: abortController.signal,
    onStepFinish: (event) => {
      if (event.finishReason === "error") {
        hasToolError = true;
      }
      log.info(
        {
          stepText: event.text?.substring(0, 200) || "(empty)",
          toolCalls: event.toolCalls?.map((tc: any) => ({
            name: tc.toolName,
            args: tc.args,
          })),
          toolResults: event.toolResults?.map((tr: any) => ({
            name: tr.toolName,
            result: JSON.stringify(tr.result).substring(0, 200),
          })),
          finishReason: event.finishReason,
        },
        "LLM step finished"
      );
    },
  });

  // If a tool_use_failed error occurs, retry once without tools
  const wrappedTextStream = async function* () {
    let hasContent = false;
    for await (const delta of result.textStream) {
      hasContent = true;
      yield delta;
    }

    // If no text was produced and there was a tool error, retry without tools
    if (!hasContent && hasToolError) {
      log.warn("Tool use failed — retrying without tools");
      const retryResult = streamText({
        model: groq.chat(env.GROQ_LLM_MODEL),
        system: getSystemPrompt(ctx),
        messages: conversationHistory,
        temperature: 0.7,
        maxOutputTokens: 150,
        abortSignal: abortController.signal,
      });
      for await (const delta of retryResult.textStream) {
        yield delta;
      }
    }
  };

  return {
    textStream: wrappedTextStream(),
    text: result.text,
    abort: () => abortController.abort(),
  };
}
