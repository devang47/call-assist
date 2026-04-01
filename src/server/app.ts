import Fastify from "fastify";
import fastifyFormBody from "@fastify/formbody";
import fastifyWebSocket from "@fastify/websocket";
import { env } from "../config/env.js";
import { twilioRoutes } from "./routes/twilio.js";
import { calendarRoutes } from "./routes/calendar.js";

export async function buildApp() {
  const isDev = env.NODE_ENV === "development";

  const app = Fastify({
    logger: isDev
      ? {
          level: env.LOG_LEVEL,
          transport: {
            target: "pino-pretty",
            options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" },
          },
        }
      : {
          level: env.LOG_LEVEL,
          // Production: structured JSON (Pino default)
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
