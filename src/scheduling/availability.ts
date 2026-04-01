import { calendar, getCalendarId } from "./google-calendar.js";
import { env } from "../config/env.js";

interface TimeSlot {
  start: string; // "09:00"
  end: string; // "09:30"
}

// Business hours by day of week (0 = Sunday)
const BUSINESS_HOURS: Record<number, { open: string; close: string } | null> = {
  0: null, // Sunday - closed
  1: { open: "09:00", close: "17:00" },
  2: { open: "09:00", close: "17:00" },
  3: { open: "09:00", close: "17:00" },
  4: { open: "09:00", close: "17:00" },
  5: { open: "09:00", close: "17:00" },
  6: { open: "09:00", close: "13:00" }, // Saturday half day
};

export async function checkAvailability(
  dateStr: string,
  serviceType?: string
): Promise<{ available: boolean; date: string; slots: TimeSlot[]; message: string }> {
  const date = new Date(dateStr + "T00:00:00");
  const dayOfWeek = date.getDay();
  const hours = BUSINESS_HOURS[dayOfWeek];

  if (!hours) {
    return {
      available: false,
      date: dateStr,
      slots: [],
      message: "The office is closed on this day. We are open Monday-Friday 9 AM to 5 PM and Saturday 9 AM to 1 PM.",
    };
  }

  const duration = env.PRACTICE_APPOINTMENT_DURATION_MINUTES;
  const tz = env.PRACTICE_TIMEZONE;

  // Query Google Calendar for busy times on this date
  const timeMin = `${dateStr}T${hours.open}:00`;
  const timeMax = `${dateStr}T${hours.close}:00`;

  try {
    const freeBusyResponse = await calendar.freebusy.query({
      requestBody: {
        timeMin: toISOWithTimezone(timeMin, tz),
        timeMax: toISOWithTimezone(timeMax, tz),
        timeZone: tz,
        items: [{ id: getCalendarId() }],
      },
    });

    const busySlots =
      freeBusyResponse.data.calendars?.[getCalendarId()]?.busy || [];

    // Generate all possible slots within business hours
    const allSlots = generateTimeSlots(hours.open, hours.close, duration);

    // Filter out slots that overlap with busy times
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
        message: "There are no available slots on this date. Please try another day.",
      };
    }

    return {
      available: true,
      date: dateStr,
      slots: availableSlots,
      message: `There are ${availableSlots.length} available slots on ${dateStr}.`,
    };
  } catch (err) {
    console.error("Google Calendar FreeBusy query failed:", err);
    return {
      available: false,
      date: dateStr,
      slots: [],
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

function toISOWithTimezone(localDateTime: string, timezone: string): string {
  // Create a date in the specified timezone and return ISO string
  const date = new Date(
    new Date(localDateTime).toLocaleString("en-US", { timeZone: timezone })
  );
  return new Date(localDateTime).toISOString();
}
