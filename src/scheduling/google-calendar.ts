import { google } from "googleapis";
import { env } from "../config/env.js";

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

const oauth2Client = new google.auth.OAuth2(
  env.GOOGLE_CLIENT_ID,
  env.GOOGLE_CLIENT_SECRET,
  `${env.SERVER_URL}/api/auth/google/callback`
);

// If a refresh token was provided via env, use it immediately
if (env.GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });
}

export const calendar = google.calendar({ version: "v3", auth: oauth2Client });

export function getCalendarId(): string {
  return env.GOOGLE_CALENDAR_ID;
}

/** Returns true if we have a refresh token (either from env or from OAuth flow) */
export function isCalendarConnected(): boolean {
  return !!oauth2Client.credentials.refresh_token;
}

/** Generate the Google OAuth consent URL for a new user to connect their calendar */
export function getAuthUrl(): string {
  return oauth2Client.generateAuthUrl({
    access_type: "offline", // Required to get a refresh_token
    prompt: "consent",      // Force consent to always get refresh_token
    scope: SCOPES,
  });
}

/** Exchange the authorization code from the callback for tokens */
export async function exchangeCodeForTokens(code: string) {
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
  };
}

/** Manually set credentials (e.g. loaded from a database) */
export function setCredentials(refreshToken: string) {
  oauth2Client.setCredentials({ refresh_token: refreshToken });
}
