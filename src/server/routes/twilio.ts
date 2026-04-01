import { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";
import { handleMediaStream } from "../../voice/audio-proxy.js";

export async function twilioRoutes(app: FastifyInstance) {
  // Twilio sends a POST here when a call comes in.
  // We respond with TwiML that opens a bidirectional media stream.
  app.post("/incoming-call", async (request, reply) => {
    app.log.info("Incoming call received");

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Please wait while we connect you to our assistant.</Say>
  <Connect>
    <Stream url="wss://${request.headers.host}/twilio/media-stream" />
  </Connect>
</Response>`;

    reply.type("text/xml").send(twiml);
  });

  // Bidirectional WebSocket for Twilio Media Streams.
  // Each connected call gets its own WebSocket + OpenAI Realtime session.
  app.get("/media-stream", { websocket: true }, (socket, request) => {
    app.log.info("Twilio media stream connected");
    handleMediaStream(socket, app.log);
  });

  // Twilio calls this when the call status changes (completed, failed, etc.)
  app.post("/call-status", async (request, reply) => {
    const body = request.body as Record<string, string>;
    app.log.info({ callSid: body.CallSid, status: body.CallStatus }, "Call status update");
    reply.send({ received: true });
  });
}
