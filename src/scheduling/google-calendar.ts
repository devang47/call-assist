import { google, type calendar_v3 } from "googleapis";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { env } from "../config/env.js";
import { db } from "../db/index.js";
import { googleOauthTokens } from "../db/schema.js";

const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const OAUTH_CALLBACK_PATH = "/api/auth/google/callback";

// Cache per-practice calendar clients
const clientCache = new Map<
  string,
  { calendar: calendar_v3.Calendar; expiresAt: number }
>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Get a Google Calendar client for a specific practice */
export async function getCalendarClientForPractice(
  practiceId: string
): Promise<calendar_v3.Calendar> {
  const cached = clientCache.get(practiceId);
  if (cached && cached.expiresAt > Date.now()) return cached.calendar;

  const oauth2Client = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    `${env.SERVER_URL}${OAUTH_CALLBACK_PATH}`
  );

  // Try loading tokens from DB
  const tokenRow = db
    .select()
    .from(googleOauthTokens)
    .where(eq(googleOauthTokens.practiceId, practiceId))
    .get();

  if (tokenRow) {
    oauth2Client.setCredentials({
      refresh_token: tokenRow.refreshToken,
      access_token: tokenRow.accessToken || undefined,
      expiry_date: tokenRow.expiryDate || undefined,
    });
  } else if (env.GOOGLE_REFRESH_TOKEN) {
    // Fallback to env var for backward compatibility
    oauth2Client.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });
  } else {
    throw new Error(`No Google OAuth tokens found for practice ${practiceId}`);
  }

  const calendarClient = google.calendar({ version: "v3", auth: oauth2Client });
  clientCache.set(practiceId, {
    calendar: calendarClient,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return calendarClient;
}

/** Check if a practice has Google Calendar connected */
export function isCalendarConnected(practiceId: string): boolean {
  const row = db
    .select()
    .from(googleOauthTokens)
    .where(eq(googleOauthTokens.practiceId, practiceId))
    .get();
  return !!row || !!env.GOOGLE_REFRESH_TOKEN;
}

/** Generate Google OAuth consent URL for a practice */
export function getAuthUrl(practiceId: string): string {
  const oauth2Client = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    `${env.SERVER_URL}${OAUTH_CALLBACK_PATH}`
  );

  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state: practiceId,
  });
}

/** Exchange OAuth code for tokens and store in DB */
export async function exchangeAndStoreTokens(
  practiceId: string,
  code: string
) {
  const oauth2Client = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    `${env.SERVER_URL}${OAUTH_CALLBACK_PATH}`
  );

  const { tokens } = await oauth2Client.getToken(code);

  // Upsert tokens in DB
  const existing = db
    .select()
    .from(googleOauthTokens)
    .where(eq(googleOauthTokens.practiceId, practiceId))
    .get();

  if (existing) {
    db.update(googleOauthTokens)
      .set({
        accessToken: tokens.access_token || null,
        refreshToken: tokens.refresh_token || existing.refreshToken,
        expiryDate: tokens.expiry_date || null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(googleOauthTokens.practiceId, practiceId))
      .run();
  } else {
    db.insert(googleOauthTokens)
      .values({
        id: nanoid(),
        practiceId,
        accessToken: tokens.access_token || null,
        refreshToken: tokens.refresh_token!,
        expiryDate: tokens.expiry_date || null,
      })
      .run();
  }

  // Invalidate cache
  clientCache.delete(practiceId);

  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
  };
}
