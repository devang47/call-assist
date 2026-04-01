import { FastifyInstance } from "fastify";
import {
  getAuthUrl,
  exchangeCodeForTokens,
  isCalendarConnected,
} from "../../scheduling/google-calendar.js";

export async function calendarRoutes(app: FastifyInstance) {
  // Step 1: Redirect to Google OAuth consent screen
  app.get("/auth/google", async (request, reply) => {
    const url = getAuthUrl();
    reply.redirect(url);
  });

  // Step 2: Google redirects back here with an authorization code
  app.get("/auth/google/callback", async (request, reply) => {
    const { code, error } = request.query as { code?: string; error?: string };

    if (error) {
      app.log.error({ error }, "Google OAuth error");
      reply.type("text/html").send(`
        <h2>Connection Failed</h2>
        <p>Google returned an error: ${error}</p>
        <a href="/api/auth/google">Try again</a>
      `);
      return;
    }

    if (!code) {
      reply.status(400).send({ error: "Missing authorization code" });
      return;
    }

    try {
      const tokens = await exchangeCodeForTokens(code);

      app.log.info("Google Calendar connected successfully");

      // For MVP: show the refresh token so they can add it to .env
      // In production: store in database per practice
      reply.type("text/html").send(`
        <h2>Google Calendar Connected</h2>
        <p>Your calendar is now linked. The AI assistant can manage appointments.</p>
        ${tokens.refresh_token ? `
          <details>
            <summary>Refresh token (save to .env for persistence across restarts)</summary>
            <code style="word-break:break-all;display:block;padding:12px;background:#f0f0f0;margin-top:8px;">GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}</code>
          </details>
        ` : "<p><em>No new refresh token issued (already authorized). Your existing token still works.</em></p>"}
      `);
    } catch (err) {
      app.log.error({ err }, "Failed to exchange OAuth code for tokens");
      reply.status(500).type("text/html").send(`
        <h2>Connection Failed</h2>
        <p>Could not complete authorization. Please try again.</p>
        <a href="/api/auth/google">Retry</a>
      `);
    }
  });

  // Check connection status
  app.get("/auth/google/status", async () => {
    return { connected: isCalendarConnected() };
  });
}
