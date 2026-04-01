import { FastifyInstance } from "fastify";
import { handleMediaStream } from "../../voice/audio-proxy.js";
import {
  loadPracticeByTwilioNumber,
  getFallbackPracticeContext,
} from "../../db/practice-context.js";
import { createCallLog, updateCallLog } from "../../db/queries/call-logs.js";
import { findOrCreatePatient } from "../../db/queries/patients.js";
import { validateTwilioSignature } from "../../middleware/twilio-signature.js";

export async function twilioRoutes(app: FastifyInstance) {
  // Validate Twilio webhook signatures on POST routes
  app.addHook("preHandler", validateTwilioSignature);

  // Twilio sends a POST here when a call comes in.
  app.post("/incoming-call", async (request, reply) => {
    const body = request.body as Record<string, string>;
    const toNumber = body.To || "";
    const callerPhone = body.From || "";
    const callSid = body.CallSid || "";

    app.log.info({ to: toNumber, from: callerPhone, callSid }, "Incoming call received");

    // Look up practice by Twilio number, fall back to env config
    const ctx = loadPracticeByTwilioNumber(toNumber) || getFallbackPracticeContext();

    // Create patient record and call log
    let patientId: string | undefined;
    let callLogId: string | undefined;
    try {
      if (callerPhone && ctx.id !== "__env_fallback__") {
        patientId = findOrCreatePatient(ctx.id, callerPhone);
      }
      if (ctx.id !== "__env_fallback__") {
        callLogId = createCallLog({
          practiceId: ctx.id,
          callSid,
          callerPhone,
          patientId,
        });
      }
    } catch (err) {
      app.log.error({ err }, "Failed to create call log / patient record");
    }

    // Use <Parameter> elements — they arrive in the WebSocket start event
    // as customParameters. This is more reliable than query params.
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Please wait while we connect you to our assistant.</Say>
  <Connect>
    <Stream url="wss://${request.headers.host}/twilio/media-stream">
      <Parameter name="practiceId" value="${ctx.id}" />
      <Parameter name="callerPhone" value="${callerPhone}" />
      <Parameter name="callLogId" value="${callLogId || ""}" />
    </Stream>
  </Connect>
</Response>`;

    reply.type("text/xml").send(twiml);
  });

  // Bidirectional WebSocket for Twilio Media Streams.
  // Practice context and call metadata come from the start event's customParameters.
  app.get("/media-stream", { websocket: true }, (socket, _request) => {
    app.log.info("Twilio media stream WebSocket connected");
    handleMediaStream(socket, app.log);
  });

  // Twilio calls this when the call status changes (completed, failed, etc.)
  app.post("/call-status", async (request, reply) => {
    const body = request.body as Record<string, string>;
    const callSid = body.CallSid;
    const status = body.CallStatus;
    const duration = body.CallDuration;
    const price = body.Price;

    app.log.info({ callSid, status, duration, price }, "Call status update");

    if (callSid && (status === "completed" || status === "failed" || status === "no-answer")) {
      try {
        updateCallLog(callSid, {
          endedAt: new Date().toISOString(),
          durationSeconds: duration ? parseInt(duration, 10) : undefined,
          costCents: price ? Math.round(Math.abs(parseFloat(price)) * 100) : undefined,
        });
      } catch (err) {
        app.log.error({ err }, "Failed to update call log on status change");
      }
    }

    reply.type("text/xml").send("<Response/>");
  });
}
