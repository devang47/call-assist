import { FastifyInstance } from "fastify";
import {
  getAuthUrl,
  exchangeAndStoreTokens,
  isCalendarConnected,
} from "../../scheduling/google-calendar.js";
import {
  loadActivePractices,
  loadPracticeById,
} from "../../db/practice-context.js";

export async function calendarRoutes(app: FastifyInstance) {
  function resolvePracticeId(preferredPracticeId?: string): {
    practiceId: string | null;
    error?: string;
  } {
    if (preferredPracticeId) {
      const practice = loadPracticeById(preferredPracticeId);
      if (!practice) {
        return { practiceId: null, error: "Practice not found" };
      }
      return { practiceId: practice.id };
    }

    const activePractices = loadActivePractices();
    if (activePractices.length === 1) {
      return { practiceId: activePractices[0].id };
    }

    if (activePractices.length === 0) {
      return { practiceId: null, error: "No active practices found" };
    }

    return {
      practiceId: null,
      error: "Multiple active practices found. Use /api/practices/:practiceId/auth/google.",
    };
  }

  // Backward-compatible single-practice entrypoint
  app.get("/auth/google", async (_request, reply) => {
    const { practiceId, error } = resolvePracticeId();
    if (!practiceId) {
      reply.status(400).send({ error });
      return;
    }

    reply.redirect(`/api/practices/${practiceId}/auth/google`);
  });

  // Step 1: Redirect to Google OAuth consent screen
  app.get("/practices/:practiceId/auth/google", async (request, reply) => {
    const { practiceId } = request.params as { practiceId: string };

    const resolved = resolvePracticeId(practiceId);
    if (!resolved.practiceId) {
      reply.status(404).send({ error: resolved.error });
      return;
    }

    const url = getAuthUrl(resolved.practiceId);
    reply.redirect(url);
  });

  async function handleGoogleCallback(
    practiceId: string | undefined,
    code: string | undefined,
    error: string | undefined,
    reply: { status: (code: number) => any; type: (mime: string) => any; send: (payload: any) => any }
  ) {
    const resolved = resolvePracticeId(practiceId);
    if (!resolved.practiceId) {
      reply.status(400).send({ error: resolved.error });
      return;
    }

    if (error) {
      app.log.error({ error, practiceId: resolved.practiceId }, "Google OAuth error");
      reply.type("text/html").send(`
        <h2>Connection Failed</h2>
        <p>Google returned an error: ${error}</p>
        <a href="/api/practices/${resolved.practiceId}/auth/google">Try again</a>
      `);
      return;
    }

    if (!code) {
      reply.status(400).send({ error: "Missing authorization code" });
      return;
    }

    try {
      await exchangeAndStoreTokens(resolved.practiceId, code);

      app.log.info({ practiceId: resolved.practiceId }, "Google Calendar connected successfully");

      reply.type("text/html").send(`
        <h2>Google Calendar Connected</h2>
        <p>Your calendar is now linked. The AI assistant can manage appointments.</p>
      `);
    } catch (err) {
      app.log.error({ err, practiceId: resolved.practiceId }, "Failed to exchange OAuth code for tokens");
      reply.status(500).type("text/html").send(`
        <h2>Connection Failed</h2>
        <p>Could not complete authorization. Please try again.</p>
        <a href="/api/practices/${resolved.practiceId}/auth/google">Retry</a>
      `);
    }
  }

  // Step 2: Google redirects back here with an authorization code
  app.get("/auth/google/callback", async (request, reply) => {
    const { code, error, state } = request.query as {
      code?: string;
      error?: string;
      state?: string;
    };
    await handleGoogleCallback(state, code, error, reply);
  });

  app.get("/practices/:practiceId/auth/google/callback", async (request, reply) => {
    const { practiceId } = request.params as { practiceId: string };
    const { code, error } = request.query as { code?: string; error?: string };
    await handleGoogleCallback(practiceId, code, error, reply);
  });

  // Check connection status for a practice
  app.get("/practices/:practiceId/auth/google/status", async (request) => {
    const { practiceId } = request.params as { practiceId: string };
    return { connected: isCalendarConnected(practiceId) };
  });
}
