import { FastifyInstance } from "fastify";
import {
  getAuthUrl,
  exchangeAndStoreTokens,
  isCalendarConnected,
} from "../../scheduling/google-calendar.js";
import { loadPracticeById } from "../../db/practice-context.js";

export async function calendarRoutes(app: FastifyInstance) {
  // Step 1: Redirect to Google OAuth consent screen
  app.get("/practices/:practiceId/auth/google", async (request, reply) => {
    const { practiceId } = request.params as { practiceId: string };

    const practice = loadPracticeById(practiceId);
    if (!practice) {
      reply.status(404).send({ error: "Practice not found" });
      return;
    }

    const url = getAuthUrl(practiceId);
    reply.redirect(url);
  });

  // Step 2: Google redirects back here with an authorization code
  app.get("/practices/:practiceId/auth/google/callback", async (request, reply) => {
    const { practiceId } = request.params as { practiceId: string };
    const { code, error } = request.query as { code?: string; error?: string };

    if (error) {
      app.log.error({ error, practiceId }, "Google OAuth error");
      reply.type("text/html").send(`
        <h2>Connection Failed</h2>
        <p>Google returned an error: ${error}</p>
        <a href="/api/practices/${practiceId}/auth/google">Try again</a>
      `);
      return;
    }

    if (!code) {
      reply.status(400).send({ error: "Missing authorization code" });
      return;
    }

    try {
      await exchangeAndStoreTokens(practiceId, code);

      app.log.info({ practiceId }, "Google Calendar connected successfully");

      reply.type("text/html").send(`
        <h2>Google Calendar Connected</h2>
        <p>Your calendar is now linked. The AI assistant can manage appointments.</p>
      `);
    } catch (err) {
      app.log.error({ err, practiceId }, "Failed to exchange OAuth code for tokens");
      reply.status(500).type("text/html").send(`
        <h2>Connection Failed</h2>
        <p>Could not complete authorization. Please try again.</p>
        <a href="/api/practices/${practiceId}/auth/google">Retry</a>
      `);
    }
  });

  // Check connection status for a practice
  app.get("/practices/:practiceId/auth/google/status", async (request) => {
    const { practiceId } = request.params as { practiceId: string };
    return { connected: isCalendarConnected(practiceId) };
  });
}
