import { getCalendarClientForPractice } from "./google-calendar.js";
import type { PracticeContext } from "../db/practice-context.js";
import { localDateTimeToIso } from "../lib/time.js";

interface BookingParams {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM (24h)
  patientName: string;
  patientPhone?: string;
  serviceType?: string;
  notes?: string;
}

interface BookingResult {
  success: boolean;
  message: string;
  appointmentId?: string;
  date?: string;
  time?: string;
  service?: string;
}

export async function bookAppointment(
  params: BookingParams,
  ctx: PracticeContext
): Promise<BookingResult> {
  const { date, time, patientName, patientPhone, serviceType, notes } = params;
  const duration = ctx.appointmentDurationMinutes;
  const tz = ctx.timezone;

  const startDateTime = `${date}T${time}:00`;
  const endMinutes = timeToMinutes(time) + duration;
  const endTime = minutesToTime(endMinutes);
  const endDateTime = `${date}T${endTime}:00`;

  const summary = serviceType
    ? `${serviceType.charAt(0).toUpperCase() + serviceType.slice(1)} - ${patientName}`
    : `Appointment - ${patientName}`;

  const description = [
    `Patient: ${patientName}`,
    patientPhone ? `Phone: ${patientPhone}` : null,
    serviceType ? `Service: ${serviceType}` : null,
    notes ? `Notes: ${notes}` : null,
    "",
    "Booked by Call-Assist AI",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const calendar = await getCalendarClientForPractice(ctx.id);

    // Re-check right before inserting: the slot may have been taken since the
    // caller heard it offered (another caller, staff, or a stale prefetch).
    // ponytail: check-then-insert still has a small race window; a per-practice lock fixes it if volume grows.
    const freeBusy = await calendar.freebusy.query({
      requestBody: {
        timeMin: localDateTimeToIso(date, time, tz),
        timeMax: localDateTimeToIso(date, endTime, tz),
        timeZone: tz,
        items: [{ id: ctx.googleCalendarId }],
      },
    });
    const busy = freeBusy.data.calendars?.[ctx.googleCalendarId]?.busy ?? [];
    if (busy.length > 0) {
      return {
        success: false,
        message: `The ${time} slot on ${date} was just taken. Apologize, then call check_availability again and offer the caller a different time.`,
      };
    }

    const event = await calendar.events.insert({
      calendarId: ctx.googleCalendarId,
      requestBody: {
        summary,
        description,
        start: {
          dateTime: startDateTime,
          timeZone: tz,
        },
        end: {
          dateTime: endDateTime,
          timeZone: tz,
        },
        reminders: {
          useDefault: false,
          overrides: [
            { method: "email", minutes: 60 },
            { method: "popup", minutes: 30 },
          ],
        },
      },
    });

    return {
      success: true,
      message: `Appointment booked successfully for ${patientName} on ${date} at ${time}.`,
      appointmentId: event.data.id || undefined,
      date,
      time,
      service: serviceType,
    };
  } catch (err) {
    console.error("Google Calendar event creation failed:", err);
    return {
      success: false,
      message:
        "I was unable to book the appointment right now. Could I take your information and have someone call you back to confirm?",
    };
  }
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
