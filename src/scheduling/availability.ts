import { getCalendarClientForPractice } from "./google-calendar.js";
import type { PracticeContext } from "../db/practice-context.js";

interface TimeSlot {
  start: string; // "09:00"
  end: string; // "09:30"
}

export async function checkAvailability(
  dateStr: string,
  serviceType: string | undefined,
  ctx: PracticeContext
): Promise<{ available: boolean; date: string; slots: TimeSlot[]; message: string }> {
  const date = new Date(dateStr + "T00:00:00");
  const dayOfWeek = date.getDay();
  const hours = ctx.businessHours[dayOfWeek];

  if (!hours) {
    return {
      available: false,
      date: dateStr,
      slots: [],
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

function toISOWithTimezone(localDateTime: string, _timezone: string): string {
  return new Date(localDateTime).toISOString();
}
