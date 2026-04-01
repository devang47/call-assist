import Twilio from "twilio";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../config/env.js";
import type { PracticeContext } from "../db/practice-context.js";

const twilioClient = Twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

export function sendBookingConfirmationSms(
  callerPhone: string,
  details: { date: string; time: string; patientName: string; service?: string },
  ctx: PracticeContext,
  log: FastifyBaseLogger
) {
  const { date, time, patientName, service } = details;

  const body = [
    `Hi ${patientName}! Your appointment at ${ctx.name} is confirmed.`,
    `Date: ${date}`,
    `Time: ${time}`,
    service ? `Service: ${service}` : null,
    ctx.address ? `Location: ${ctx.address}` : null,
    `If you need to reschedule, call us at ${ctx.phone || ctx.twilioNumber}.`,
  ]
    .filter(Boolean)
    .join("\n");

  // Fire and forget — don't block the call pipeline
  twilioClient.messages
    .create({
      body,
      from: ctx.twilioNumber,
      to: callerPhone,
    })
    .then(() => {
      log.info({ to: callerPhone }, "SMS booking confirmation sent");
    })
    .catch((err) => {
      log.error({ err, to: callerPhone }, "Failed to send SMS booking confirmation");
    });
}
