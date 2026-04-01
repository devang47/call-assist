import Fastify from "fastify";
import fastifyFormBody from "@fastify/formbody";
import fastifyWebSocket from "@fastify/websocket";
import { twilioRoutes } from "./routes/twilio.js";
import { calendarRoutes } from "./routes/calendar.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: "info",
      transport: {
        target: "pino-pretty",
        options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" },
      },
    },
  });

  // Parse URL-encoded bodies (Twilio webhooks send form data)
  await app.register(fastifyFormBody);

  // WebSocket support
  await app.register(fastifyWebSocket);

  // Health check
  app.get("/health", async () => ({ status: "ok" }));

  // Twilio routes
  await app.register(twilioRoutes, { prefix: "/twilio" });

  // Google Calendar OAuth routes
  await app.register(calendarRoutes, { prefix: "/api" });

  return app;
}
