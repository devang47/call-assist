import type { PracticeContext } from "../db/practice-context.js";
import { checkAvailability } from "../scheduling/availability.js";
import { getCurrentDateInTimeZone, nextWeekdayInTimeZone, offsetDateInTimeZone } from "../lib/time.js";

/**
 * Speculative prefetch for check_availability.
 *
 * When the STT transcript looks like a scheduling request, we fire
 * checkAvailability in parallel with the LLM call. If the LLM does
 * call check_availability with the same date, the cached result is
 * returned instantly — saving 500-1500ms.
 */

interface CachedResult {
  result: Awaited<ReturnType<typeof checkAvailability>>;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000; // 30s — fresh enough for a single call turn

// Keyed by "practiceId:date"
const prefetchCache = new Map<string, Promise<CachedResult>>();

const SCHEDULING_KEYWORDS = /\b(appointment|book|schedule|slot|available|opening|tomorrow|today|next\s+\w+day|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;

const MONTH_MAP: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Next occurrence of month/day on or after today in the practice's timezone
 * ("5 jan" said in December means next year). Null for dates like "31 feb".
 */
function upcomingDate(month: number, day: number, timeZone: string): string | null {
  const today = getCurrentDateInTimeZone(timeZone);
  const year = Number(today.slice(0, 4));
  for (const y of [year, year + 1]) {
    const d = new Date(Date.UTC(y, month, day));
    if (d.getUTCMonth() !== month) return null;
    const iso = d.toISOString().slice(0, 10);
    if (iso >= today) return iso;
  }
  return null;
}

/**
 * Try to extract a YYYY-MM-DD date from the transcript.
 * Returns null if no date can be inferred.
 */
export function extractDate(transcript: string, timeZone: string): string | null {
  // Relative dates
  if (/\btomorrow\b/i.test(transcript)) return offsetDateInTimeZone(timeZone, 1);
  if (/\btoday\b/i.test(transcript)) return offsetDateInTimeZone(timeZone, 0);

  // "next <weekday>"
  const nextDay = transcript.match(/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (nextDay) {
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const target = dayNames.indexOf(nextDay[1].toLowerCase());
    if (target >= 0) return nextWeekdayInTimeZone(timeZone, target);
  }

  // "3rd of april", "april 3rd", "3 april"
  const dmy = transcript.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*/i);
  if (dmy) {
    const day = parseInt(dmy[1]);
    const month = MONTH_MAP[dmy[2].toLowerCase().substring(0, 3)];
    if (month !== undefined) return upcomingDate(month, day, timeZone);
  }
  const mdy = transcript.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (mdy) {
    const month = MONTH_MAP[mdy[1].toLowerCase().substring(0, 3)];
    const day = parseInt(mdy[2]);
    if (month !== undefined) return upcomingDate(month, day, timeZone);
  }

  return null;
}

function cacheKey(practiceId: string, date: string): string {
  return `${practiceId}:${date}`;
}

/**
 * Check if a transcript looks like a scheduling request and
 * speculatively prefetch availability.
 *
 * Call this right after STT, before the LLM call.
 * Returns true if a prefetch was started.
 */
export function maybePrefetchAvailability(
  transcript: string,
  ctx: PracticeContext
): boolean {
  if (!SCHEDULING_KEYWORDS.test(transcript)) return false;

  const date = extractDate(transcript, ctx.timezone);
  if (!date) return false;

  const key = cacheKey(ctx.id, date);
  if (prefetchCache.has(key)) return false; // already in flight or cached

  const promise = checkAvailability(date, undefined, ctx).then((result) => ({
    result,
    expiresAt: Date.now() + CACHE_TTL_MS,
  }));

  prefetchCache.set(key, promise);

  // Auto-cleanup after TTL
  promise.then((cached) => {
    setTimeout(() => {
      // Only if it wasn't invalidated and replaced by a newer prefetch meanwhile
      if (prefetchCache.get(key) === promise) prefetchCache.delete(key);
    }, CACHE_TTL_MS);
  });

  return true;
}

/** Drop a cached result once a booking changes that day's calendar. */
export function invalidatePrefetch(practiceId: string, date: string): void {
  prefetchCache.delete(cacheKey(practiceId, date));
}

/**
 * Get a cached prefetch result, if available.
 * Returns null if no cached result exists for this date.
 */
export async function getCachedAvailability(
  practiceId: string,
  date: string
): Promise<Awaited<ReturnType<typeof checkAvailability>> | null> {
  const key = cacheKey(practiceId, date);
  const entry = prefetchCache.get(key);
  if (!entry) return null;

  try {
    const cached = await entry;
    if (cached.expiresAt < Date.now()) {
      prefetchCache.delete(key);
      return null;
    }
    return cached.result;
  } catch {
    prefetchCache.delete(key);
    return null;
  }
}
