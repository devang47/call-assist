import { createOpenAI } from "@ai-sdk/openai";
import { streamText, tool, stepCountIs, type ModelMessage } from "ai";
import { z } from "zod";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../config/env.js";
import { getSystemPrompt } from "../voice/prompts.js";
import { checkAvailability, type AvailabilityResult } from "../scheduling/availability.js";
import { bookAppointment } from "../scheduling/booking.js";
import type { PracticeContext } from "../db/practice-context.js";
import { getCachedAvailability } from "./prefetch.js";
import type { CallEventLogger } from "../lib/call-debug-log.js";

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
  onBookingComplete: (details: { date: string; time: string; patientName: string; patientPhone: string; service?: string }) => void;
}

const INVALID_NAMES = new Set(["not provided", "unknown", "n/a", "caller", "patient", ""]);

function hasUsablePhoneNumber(phone: string): boolean {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 7;
}

function createTools(
  ctx: PracticeContext,
  callbacks: ToolCallbacks,
  log: FastifyBaseLogger,
  eventLogger?: CallEventLogger
) {
  const availabilityCalls = new Map<string, number>();
  const availabilityResults = new Map<string, AvailabilityResult>();
  const availabilityInFlight = new Map<string, Promise<AvailabilityResult>>();

  return {
    check_availability: tool({
      description:
        "Check available appointment slots for a given date. If the caller mentioned an exact time like 12 p.m. or 14:00, include requested_time so the tool can confirm that exact time instead of forcing you to guess.",
      inputSchema: z.object({
        date: z.string().describe("The date to check availability for, in YYYY-MM-DD format"),
        service_type: z
          .string()
          .optional()
          .describe("Type of appointment: cleaning, checkup, filling, extraction, root_canal, crown, whitening, consultation, emergency"),
        requested_time: z
          .string()
          .optional()
          .describe("Exact time the caller asked about, like '12 p.m.', '2:30 pm', or '14:00'"),
      }),
      execute: async ({ date, service_type, requested_time }) => {
        const requestKey = JSON.stringify({
          date,
          service_type: service_type ?? null,
          requested_time: requested_time ?? null,
        });
        const repeatCount = (availabilityCalls.get(requestKey) ?? 0) + 1;
        availabilityCalls.set(requestKey, repeatCount);

        log.info({ tool: "check_availability", date, service_type, requested_time }, "Tool called");
        eventLogger?.logEvent("tool_called", {
          tool: "check_availability",
          args: { date, service_type, requested_time },
        });

        callbacks.onToolStart("check_availability");

        const reuseExistingResult = async (): Promise<AvailabilityResult | null> => {
          const cachedResult = availabilityResults.get(requestKey);
          if (cachedResult) return cachedResult;

          const inFlight = availabilityInFlight.get(requestKey);
          if (!inFlight) return null;
          return inFlight;
        };

        if (repeatCount > 1) {
          const repeatedResult = await reuseExistingResult();
          if (repeatedResult) {
            const duplicateResult: AvailabilityResult & { duplicateRequest: boolean } = {
              ...repeatedResult,
              duplicateRequest: true,
              message: `${repeatedResult.message} This exact availability was already checked in this turn. Use this result to answer the caller instead of calling the tool again.`,
            };
            log.warn({ tool: "check_availability", date, service_type, requested_time, repeatCount }, "Duplicate availability lookup in same turn");
            eventLogger?.logEvent("tool_result", {
              tool: "check_availability",
              duplicateRequest: true,
              result: duplicateResult,
            });
            return duplicateResult;
          }
        }

        // Check speculative prefetch cache first
        const cached = requested_time ? null : await getCachedAvailability(ctx.id, date);
        if (cached) {
          log.info({ tool: "check_availability", available: cached.available, slots: cached.slots.length, prefetched: true }, "Tool result (from prefetch cache)");
          availabilityResults.set(requestKey, cached);
          eventLogger?.logEvent("tool_result", {
            tool: "check_availability",
            prefetched: true,
            result: cached,
          });
          return cached;
        }

        const promise = checkAvailability(date, service_type, ctx, requested_time);
        availabilityInFlight.set(requestKey, promise);
        let result: AvailabilityResult;
        try {
          result = await promise;
        } finally {
          availabilityInFlight.delete(requestKey);
        }
        availabilityResults.set(requestKey, result);
        log.info({ tool: "check_availability", available: result.available, slots: result.slots.length }, "Tool result");
        eventLogger?.logEvent("tool_result", {
          tool: "check_availability",
          result,
        });
        return result;
      },
    }),

    book_appointment: tool({
      description:
        "Book an appointment slot for the caller. Use ONLY after the caller explicitly confirms the service, date, time, callback phone number, and says yes.",
      inputSchema: z.object({
        date: z.string().describe("Appointment date in YYYY-MM-DD format"),
        time: z.string().describe("Appointment time in HH:MM 24-hour format (e.g., 14:00)"),
        patient_name: z.string().describe("Full name of the patient as they stated it"),
        patient_phone: z.string().describe("Callback phone number of the patient"),
        service_type: z.string().optional().describe("Type of dental service"),
        notes: z.string().optional().describe("Any additional notes about the appointment"),
      }),
      execute: async ({ date, time, patient_name, patient_phone, service_type, notes }) => {
        log.info({ tool: "book_appointment", date, time, patient_name, service_type }, "Tool called");
        eventLogger?.logEvent("tool_called", {
          tool: "book_appointment",
          args: { date, time, patient_name, patient_phone, service_type, notes },
        });

        // Reject if name is missing or placeholder
        if (INVALID_NAMES.has(patient_name.toLowerCase().trim())) {
          log.warn({ patient_name }, "Booking rejected — invalid patient name");
          eventLogger?.logEvent("tool_validation_failed", {
            tool: "book_appointment",
            patient_name,
            reason: "invalid_patient_name",
          });
          return {
            success: false,
            message: "You need to ask the caller for their name before booking.",
          };
        }

        if (!hasUsablePhoneNumber(patient_phone)) {
          log.warn({ patient_phone }, "Booking rejected — invalid patient phone");
          eventLogger?.logEvent("tool_validation_failed", {
            tool: "book_appointment",
            patient_phone,
            reason: "invalid_patient_phone",
          });
          return {
            success: false,
            message: "You need to ask the caller for their callback phone number before booking.",
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
        eventLogger?.logEvent("tool_result", {
          tool: "book_appointment",
          result,
        });
        if (result.success) {
          callbacks.onOutcome("appointment_booked", {
            appointmentId: result.appointmentId,
            service: result.service,
          });
          callbacks.onBookingComplete({
            date,
            time,
            patientName: patient_name,
            patientPhone: patient_phone,
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
        eventLogger?.logEvent("tool_called", {
          tool: "get_practice_info",
          args: { query },
        });
        const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
        const hours: Record<string, string> = {};
        for (let d = 0; d < 7; d++) {
          const h = ctx.businessHours[d];
          hours[DAY_NAMES[d]] = h ? `${h.open} - ${h.close}` : "Closed";
        }
        callbacks.onOutcome("info_provided");
        const result = {
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
        eventLogger?.logEvent("tool_result", {
          tool: "get_practice_info",
          result,
        });
        return result;
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
        eventLogger?.logEvent("tool_called", {
          tool: "transfer_to_human",
          args: { reason },
        });
        if (!ctx.staffPhone) {
          log.warn({ tool: "transfer_to_human" }, "No staff phone configured");
          eventLogger?.logEvent("tool_result", {
            tool: "transfer_to_human",
            result: {
              transfer: false,
              message:
                "No staff number is configured right now. Please take the caller's name and phone number so someone can call them back.",
            },
          });
          return {
            transfer: false,
            message:
              "No staff number is configured right now. Please take the caller's name and phone number so someone can call them back.",
          };
        }
        callbacks.onTransfer(ctx.staffPhone, reason);
        const result = { transfer: true, reason };
        eventLogger?.logEvent("tool_result", {
          tool: "transfer_to_human",
          result,
        });
        return result;
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
        const result = { hangup: true, reason };
        eventLogger?.logEvent("tool_called", {
          tool: "end_call",
          args: { reason },
        });
        eventLogger?.logEvent("tool_result", {
          tool: "end_call",
          result,
        });
        return result;
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
  log: FastifyBaseLogger,
  eventLogger?: CallEventLogger
): Promise<StreamingLLMResponse> {
  const abortController = new AbortController();

  if (abortSignal) {
    abortSignal.addEventListener("abort", () => abortController.abort());
  }

  const tools = createTools(ctx, callbacks, log, eventLogger);

  let hasToolError = false;
  eventLogger?.logEvent("llm_request_started", {
    model: env.GROQ_LLM_MODEL,
    historyLength: conversationHistory.length,
    maxSteps: env.GROQ_LLM_MAX_STEPS,
  });

  const result = streamText({
    model: groq.chat(env.GROQ_LLM_MODEL),
    system: getSystemPrompt(ctx),
    messages: conversationHistory,
    tools,
    stopWhen: stepCountIs(env.GROQ_LLM_MAX_STEPS),
    temperature: env.GROQ_LLM_TEMPERATURE,
    maxOutputTokens: env.GROQ_LLM_MAX_OUTPUT_TOKENS,
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
      eventLogger?.logEvent("llm_step_finished", {
        stepText: event.text?.substring(0, 200) || "",
        toolCalls: event.toolCalls?.map((tc: any) => ({
          name: tc.toolName,
          args: tc.args,
        })),
        toolResults: event.toolResults?.map((tr: any) => ({
          name: tr.toolName,
          result: tr.result,
        })),
        finishReason: event.finishReason,
      });
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
      eventLogger?.logEvent("llm_tool_retry_without_tools");
      const retryResult = streamText({
        model: groq.chat(env.GROQ_LLM_MODEL),
        system: getSystemPrompt(ctx),
        messages: conversationHistory,
        temperature: env.GROQ_LLM_TEMPERATURE,
        maxOutputTokens: env.GROQ_LLM_MAX_OUTPUT_TOKENS,
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
