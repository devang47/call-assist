import { getCalendarClientForPractice } from "./google-calendar.js";
import type { PracticeContext } from "../db/practice-context.js";
import { env } from "../config/env.js";
import { localDateTimeToIso } from "../lib/time.js";

interface TimeSlot {
  start: string; // "09:00"
  end: string; // "09:30"
}

interface RequestedTimeAvailability {
  raw: string;
  normalized: string | null;
  available: boolean;
  reason: "available" | "busy" | "outside_business_hours" | "invalid_time";
  matchingSlot: TimeSlot | null;
}

export interface AvailabilityResult {
  available: boolean;
  date: string;
  slots: TimeSlot[];
  suggestedSlots: TimeSlot[];
  totalSlots: number;
  hasMoreSlots: boolean;
  requestedTime: RequestedTimeAvailability | null;
  message: string;
}

export async function checkAvailability(
  dateStr: string,
  serviceType: string | undefined,
  ctx: PracticeContext,
  requestedTime?: string
): Promise<AvailabilityResult> {
  const date = new Date(dateStr + "T00:00:00");
  const dayOfWeek = date.getDay();
  const hours = ctx.businessHours[dayOfWeek];
  const normalizedRequestedTime = normalizeRequestedTime(requestedTime);

  if (!hours) {
    return {
      available: false,
      date: dateStr,
      slots: [],
      suggestedSlots: [],
      totalSlots: 0,
      hasMoreSlots: false,
      requestedTime: buildRequestedTimeAvailability(requestedTime, normalizedRequestedTime, [], [], undefined),
      message: "The office is closed on this day.",
    };
  }

  const duration = ctx.appointmentDurationMinutes;
  const tz = ctx.timezone;

  const timeMin = `${dateStr}T${hours.open}:00`;
  const timeMax = `${dateStr}T${hours.close}:00`;

  try {
    const calendar = await getCalendarClientForPractice(ctx.id);

    const freeBusyResponse = await calendar.freebusy.query({
      requestBody: {
        timeMin: toISOWithTimezone(timeMin, tz),
        timeMax: toISOWithTimezone(timeMax, tz),
        timeZone: tz,
        items: [{ id: ctx.googleCalendarId }],
      },
    });

    const busySlots =
      freeBusyResponse.data.calendars?.[ctx.googleCalendarId]?.busy || [];

    const allSlots = generateTimeSlots(hours.open, hours.close, duration);

    const availableSlots = allSlots.filter((slot) => {
      const slotStart = new Date(`${dateStr}T${slot.start}:00`);
      const slotEnd = new Date(`${dateStr}T${slot.end}:00`);

      return !busySlots.some((busy) => {
        const busyStart = new Date(busy.start!);
        const busyEnd = new Date(busy.end!);
        return slotStart < busyEnd && slotEnd > busyStart;
      });
    });

    if (availableSlots.length === 0) {
      return {
        available: false,
        date: dateStr,
        slots: [],
        suggestedSlots: [],
        totalSlots: 0,
        hasMoreSlots: false,
        requestedTime: buildRequestedTimeAvailability(
          requestedTime,
          normalizedRequestedTime,
          availableSlots,
          allSlots,
          hours
        ),
        message: "There are no available slots on this date. Please try another day.",
      };
    }

    const suggestedSlots = selectSuggestedSlots(
      availableSlots,
      normalizedRequestedTime,
      env.AVAILABILITY_RESULT_LIMIT
    );
    const requestedTimeAvailability = buildRequestedTimeAvailability(
      requestedTime,
      normalizedRequestedTime,
      availableSlots,
      allSlots,
      hours
    );

    return {
      available: true,
      date: dateStr,
      slots: availableSlots,
      suggestedSlots,
      totalSlots: availableSlots.length,
      hasMoreSlots: suggestedSlots.length < availableSlots.length,
      requestedTime: requestedTimeAvailability,
      message: buildAvailabilityMessage(dateStr, availableSlots.length, requestedTimeAvailability),
    };
  } catch (err) {
    console.error("Google Calendar FreeBusy query failed:", err);
    return {
      available: false,
      date: dateStr,
      slots: [],
      suggestedSlots: [],
      totalSlots: 0,
      hasMoreSlots: false,
      requestedTime: buildRequestedTimeAvailability(
        requestedTime,
        normalizedRequestedTime,
        [],
        [],
        hours
      ),
      message:
        "I'm having trouble checking the schedule right now. Could I take your number and have someone call you back?",
    };
  }
}

function generateTimeSlots(open: string, close: string, durationMinutes: number): TimeSlot[] {
  const slots: TimeSlot[] = [];
  let current = timeToMinutes(open);
  const end = timeToMinutes(close);

  while (current + durationMinutes <= end) {
    slots.push({
      start: minutesToTime(current),
      end: minutesToTime(current + durationMinutes),
    });
    current += durationMinutes;
  }

  return slots;
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

function normalizeRequestedTime(value: string | undefined): string | null {
  if (!value) return null;

  const normalized = value.trim().toLowerCase().replace(/\./g, "");
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? "0");
  const meridiem = match[3];

  if (minutes > 59 || hours > 23 || hours < 0) return null;

  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === "am") {
      hours = hours === 12 ? 0 : hours;
    } else {
      hours = hours === 12 ? 12 : hours + 12;
    }
  }

  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

function selectSuggestedSlots(
  availableSlots: TimeSlot[],
  requestedTime: string | null,
  limit: number
): TimeSlot[] {
  if (availableSlots.length <= limit) return availableSlots;
  if (!requestedTime) return availableSlots.slice(0, limit);

  const requestedMinutes = timeToMinutes(requestedTime);
  return [...availableSlots]
    .sort((a, b) => {
      const diffA = Math.abs(timeToMinutes(a.start) - requestedMinutes);
      const diffB = Math.abs(timeToMinutes(b.start) - requestedMinutes);
      if (diffA !== diffB) return diffA - diffB;
      return timeToMinutes(a.start) - timeToMinutes(b.start);
    })
    .slice(0, limit)
    .sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
}

function buildRequestedTimeAvailability(
  rawRequestedTime: string | undefined,
  normalizedRequestedTime: string | null,
  availableSlots: TimeSlot[],
  allSlots: TimeSlot[],
  hours: { open: string; close: string } | null | undefined
): RequestedTimeAvailability | null {
  if (!rawRequestedTime) return null;

  if (!normalizedRequestedTime) {
    return {
      raw: rawRequestedTime,
      normalized: null,
      available: false,
      reason: "invalid_time",
      matchingSlot: null,
    };
  }

  const availableSlot = availableSlots.find((slot) => slot.start === normalizedRequestedTime) ?? null;
  if (availableSlot) {
    return {
      raw: rawRequestedTime,
      normalized: normalizedRequestedTime,
      available: true,
      reason: "available",
      matchingSlot: availableSlot,
    };
  }

  if (!hours) {
    return {
      raw: rawRequestedTime,
      normalized: normalizedRequestedTime,
      available: false,
      reason: "outside_business_hours",
      matchingSlot: null,
    };
  }

  const requestedMinutes = timeToMinutes(normalizedRequestedTime);
  const withinBusinessHours =
    requestedMinutes >= timeToMinutes(hours.open) &&
    requestedMinutes + 1 <= timeToMinutes(hours.close);
  const existsAsSlot = allSlots.some((slot) => slot.start === normalizedRequestedTime);

  return {
    raw: rawRequestedTime,
    normalized: normalizedRequestedTime,
    available: false,
    reason: withinBusinessHours && existsAsSlot ? "busy" : "outside_business_hours",
    matchingSlot: null,
  };
}

function buildAvailabilityMessage(
  dateStr: string,
  totalSlots: number,
  requestedTime: RequestedTimeAvailability | null
): string {
  if (!requestedTime) {
    return `There are ${totalSlots} available slots on ${dateStr}.`;
  }

  if (requestedTime.available && requestedTime.normalized) {
    return `${requestedTime.normalized} is available on ${dateStr}. There are ${totalSlots} available slots on this date.`;
  }

  if (requestedTime.reason === "invalid_time") {
    return `I could not understand the requested time. There are ${totalSlots} available slots on ${dateStr}.`;
  }

  if (requestedTime.normalized) {
    return `${requestedTime.normalized} is not available on ${dateStr}. There are ${totalSlots} available slots on this date.`;
  }

  return `There are ${totalSlots} available slots on ${dateStr}.`;
}

function toISOWithTimezone(localDateTime: string, timezone: string): string {
  const [date, timeWithSeconds] = localDateTime.split("T");
  const [time] = timeWithSeconds.split(":").length >= 2
    ? [timeWithSeconds.slice(0, 5)]
    : [timeWithSeconds];
  return localDateTimeToIso(date, time, timezone);
}
