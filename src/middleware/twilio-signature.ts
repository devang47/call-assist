import type { FastifyRequest, FastifyReply } from "fastify";
import twilio from "twilio";
import { env } from "../config/env.js";

export async function validateTwilioSignature(
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!env.TWILIO_SIGNATURE_VALIDATION) return;

  // Skip validation for WebSocket upgrades — Twilio media stream
  // connections don't carry signature headers (they're authenticated
  // implicitly by being a response to a valid <Stream> directive)
  if (request.method === "GET") return;

  const signature = request.headers["x-twilio-signature"] as string;
  if (!signature) {
    request.log.warn("Missing X-Twilio-Signature header");
    reply.status(403).send({ error: "Missing signature" });
    return;
  }

  const url = `${env.SERVER_URL}${request.url}`;
  const params = (request.body as Record<string, string>) || {};

  const isValid = twilio.validateRequest(
    env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    params
  );

  if (!isValid) {
    request.log.warn({ url }, "Invalid Twilio signature");
    reply.status(403).send({ error: "Invalid signature" });
  }
}
