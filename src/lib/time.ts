const DATE_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function getDateFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = DATE_FORMATTER_CACHE.get(timeZone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  DATE_FORMATTER_CACHE.set(timeZone, formatter);
  return formatter;
}

function getDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = getDateFormatter(timeZone).formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);

  return { year, month, day };
}

function formatIsoDate(parts: { year: number; month: number; day: number }): string {
  return `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

function parseIsoDate(dateStr: string): { year: number; month: number; day: number } {
  const [year, month, day] = dateStr.split("-").map(Number);
  return { year, month, day };
}

function addDays(dateStr: string, days: number): string {
  const { year, month, day } = parseIsoDate(dateStr);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return formatIsoDate({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  });
}

function getOffsetMinutes(utcDate: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(utcDate);

  const offsetLabel = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT+00:00";
  const match = offsetLabel.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!match) return 0;

  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  return sign * (hours * 60 + minutes);
}

export function getCurrentDateInTimeZone(timeZone: string): string {
  return formatIsoDate(getDateParts(new Date(), timeZone));
}

export function offsetDateInTimeZone(timeZone: string, days: number): string {
  return addDays(getCurrentDateInTimeZone(timeZone), days);
}

export function nextWeekdayInTimeZone(timeZone: string, targetWeekday: number): string {
  const today = parseIsoDate(getCurrentDateInTimeZone(timeZone));
  const date = new Date(Date.UTC(today.year, today.month - 1, today.day));
  const currentWeekday = date.getUTCDay();
  let diff = targetWeekday - currentWeekday;
  if (diff <= 0) diff += 7;
  date.setUTCDate(date.getUTCDate() + diff);
  return formatIsoDate({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  });
}

export function localDateTimeToIso(dateStr: string, timeStr: string, timeZone: string): string {
  const baseUtcMs = Date.parse(`${dateStr}T${timeStr}:00Z`);
  let utcMs = baseUtcMs;

  // One correction pass is usually enough, but DST edges can need a second.
  for (let attempt = 0; attempt < 2; attempt++) {
    const offsetMinutes = getOffsetMinutes(new Date(utcMs), timeZone);
    utcMs = baseUtcMs - offsetMinutes * 60_000;
  }

  return new Date(utcMs).toISOString();
}
