import WebSocket from "ws";
import Twilio from "twilio";
import type { FastifyBaseLogger } from "fastify";
import type { ModelMessage } from "ai";
import { env } from "../config/env.js";
import {
  loadPracticeById,
  getFallbackPracticeContext,
  type PracticeContext,
} from "../db/practice-context.js";
import { getPatientByPhone } from "../db/queries/patients.js";
import { updateCallLog } from "../db/queries/call-logs.js";
import { appendTranscriptTurn } from "../db/queries/transcripts.js";
import { SileroVAD } from "../pipeline/vad.js";
import { GroqSTT } from "../pipeline/stt.js";
import { DeepgramTTS } from "../pipeline/tts.js";
import { SentenceBuffer } from "../pipeline/sentence-buffer.js";
import { generateResponse, type StreamingLLMResponse, type ToolCallbacks } from "../pipeline/llm.js";
import { sendBookingConfirmationSms } from "../services/sms.js";
import type { PipelineState } from "../pipeline/types.js";

interface TwilioMessage {
  event: string;
  streamSid?: string;
  start?: {
    streamSid: string;
    callSid: string;
    customParameters?: Record<string, string>;
  };
  media?: { payload: string };
  mark?: { name: string };
}

const SILENCE_TIMEOUT_MS = 30_000;
const MIN_TRANSCRIPT_WORDS = 2;
const MIN_TRANSCRIPT_LENGTH = 4;

/**
 * Returns true if the transcript is too short or looks like noise/garbage.
 */
function isGarbageTranscript(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < MIN_TRANSCRIPT_LENGTH) return true;
  const words = trimmed.split(/\s+/);
  if (words.length < MIN_TRANSCRIPT_WORDS) return true;
  // Mostly non-ASCII / non-English noise (e.g. "Treże", "pasteur Treże")
  const asciiRatio = trimmed.replace(/[^\x20-\x7E]/g, "").length / trimmed.length;
  if (asciiRatio < 0.5) return true;
  return false;
}

/**
 * Pipeline orchestrator for a single phone call.
 * Params arrive via Twilio's start event customParameters.
 */
export function handleMediaStream(
  twilioWs: WebSocket,
  log: FastifyBaseLogger
) {
  let streamSid: string | null = null;
  let callSid: string | null = null;
  let callLogId: string | undefined;
  let callerPhone: string | undefined;
  let ctx: PracticeContext | null = null;
  let state: PipelineState = "idle";
  let markCounter = 0;
  let transcriptSeq = 0;

  let turnStart: number | null = null;
  let ttsFirstByte: number | null = null;

  const conversationHistory: ModelMessage[] = [];
  let currentResponse: StreamingLLMResponse | null = null;

  // LLM turn queue — prevents concurrent requests
  let llmBusy = false;
  let pendingUtterance: string | null = null;

  // Call outcome tracking
  let callOutcome: string = "abandoned";
  let callOutcomeDetails: Record<string, unknown> = {};

  // Transfer / hangup flags
  let pendingTransfer: { staffPhone: string; reason: string } | null = null;
  let pendingHangup = false;
  let hangingUp = false;

  // Silence timer
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let silencePrompted = false;

  const vad = new SileroVAD();
  const stt = new GroqSTT();
  const tts = new DeepgramTTS();

  const twilioClient = Twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

  function logTranscript(role: string, content: string) {
    if (!callLogId) return;
    try {
      appendTranscriptTurn({
        callLogId,
        role,
        content,
        sequence: ++transcriptSeq,
      });
    } catch (err) {
      log.error({ err }, "Failed to log transcript turn");
    }
  }

  // Hold messages before tool execution
  const TOOL_HOLD_MESSAGES: Record<string, string> = {
    check_availability: "Let me check that for you.",
    book_appointment: "One moment while I book that.",
  };
  let holdMessageSent = false;

  const toolCallbacks: ToolCallbacks = {
    onOutcome: (outcome, details) => {
      callOutcome = outcome;
      if (details) callOutcomeDetails = { ...callOutcomeDetails, ...details };
    },
    onTransfer: (staffPhone, reason) => {
      pendingTransfer = { staffPhone, reason };
      callOutcome = "transferred";
      callOutcomeDetails = { ...callOutcomeDetails, transferReason: reason };
    },
    onEndCall: (reason) => {
      pendingHangup = true;
      if (callOutcome === "abandoned") callOutcome = "completed";
      callOutcomeDetails = { ...callOutcomeDetails, endReason: reason };
    },
    onToolStart: (toolName) => {
      const msg = TOOL_HOLD_MESSAGES[toolName];
      if (msg && !holdMessageSent) {
        holdMessageSent = true;
        tts.sendText(msg);
        tts.flush();
      }
    },
    onBookingComplete: (details) => {
      // Send SMS confirmation after successful booking
      if (callerPhone && ctx) {
        sendBookingConfirmationSms(callerPhone, details, ctx, log);
      }
    },
  };

  function resetSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silencePrompted = false;
    silenceTimer = setTimeout(() => {
      if (state === "listening") {
        if (!silencePrompted) {
          silencePrompted = true;
          tts.sendText("Are you still there?");
          tts.flush();
          state = "speaking";
        } else {
          log.info("Silence timeout — hanging up");
          hangupGracefully();
        }
      }
    }, SILENCE_TIMEOUT_MS);
  }

  async function hangupGracefully() {
    if (hangingUp || !callSid) return;
    hangingUp = true;
    try {
      await twilioClient.calls(callSid).update({ status: "completed" });
    } catch (err) {
      log.error({ err }, "Failed to hang up call via Twilio API");
    }
  }

  async function executeTransfer(staffPhone: string) {
    if (!callSid) return;
    try {
      const twiml = `<Response><Dial timeout="30">${staffPhone}</Dial><Say>I'm sorry, no one is available at the moment. Goodbye.</Say><Hangup/></Response>`;
      await twilioClient.calls(callSid).update({ twiml });
      log.info({ staffPhone }, "Call transferred to staff");
    } catch (err) {
      log.error({ err }, "Failed to transfer call");
    }
  }

  async function initPipeline() {
    if (!ctx) return;
    try {
      const waitStart = performance.now();
      await tts.start(); // No-op if already pre-warmed, otherwise waits for in-progress connection
      log.info({ ttsReadyMs: (performance.now() - waitStart).toFixed(0) }, "Pipeline initialized");

      // Personalized greeting for returning callers
      let greeting: string;
      if (callerPhone && ctx.id !== "__env_fallback__") {
        try {
          const patient = getPatientByPhone(ctx.id, callerPhone);
          if (patient?.name && patient.callCount > 1) {
            greeting = `Welcome back ${patient.name}! Thank you for calling ${ctx.name}. How can I help you today?`;
          } else {
            greeting = `Thank you for calling ${ctx.name}. How can I help you today?`;
          }
        } catch {
          greeting = `Thank you for calling ${ctx.name}. How can I help you today?`;
        }
      } else {
        greeting = `Thank you for calling ${ctx.name}. How can I help you today?`;
      }

      tts.sendText(greeting);
      tts.flush();
      conversationHistory.push({ role: "assistant", content: greeting });
      logTranscript("assistant", greeting);
      state = "speaking";
      log.info("Greeting sent");
    } catch (err) {
      log.error({ err }, "Failed to initialize pipeline");
    }
  }

  vad.on("speechStart", () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (state === "speaking") {
      log.info("Interruption detected");
      handleInterruption();
    }
    state = "listening";
  });

  vad.on("speechEnd", async (durationSecs: number) => {
    turnStart = performance.now();
    ttsFirstByte = null;

    if (stt.getBufferDuration() < 0.5) {
      stt.clearBuffer();
      state = "listening";
      resetSilenceTimer();
      return;
    }

    state = "thinking";
    log.info({ speechDurationS: durationSecs.toFixed(1), audioDurationS: stt.getBufferDuration().toFixed(1) }, "Speech ended, transcribing");

    try {
      const sttStart = performance.now();
      const transcript = await stt.transcribe();
      const sttMs = performance.now() - sttStart;

      if (!transcript) {
        log.info({ sttMs: +sttMs.toFixed(0) }, "Empty transcript");
        state = "listening";
        resetSilenceTimer();
        return;
      }

      // Filter garbage transcripts
      if (isGarbageTranscript(transcript)) {
        log.info({ transcript, sttMs: +sttMs.toFixed(0) }, "Garbage transcript filtered");
        state = "listening";
        resetSilenceTimer();
        return;
      }

      log.info({ transcript, sttMs: +sttMs.toFixed(0) }, "STT complete");
      enqueueLLMTurn(transcript);
    } catch (err) {
      log.error({ err }, "STT failed");
      tts.sendText("I'm sorry, I didn't catch that. Could you please repeat?");
      tts.flush();
      state = "speaking";
    }
  });

  tts.on("audio", (base64Audio: string) => {
    if (turnStart && !ttsFirstByte) {
      ttsFirstByte = performance.now();
      const perceivedMs = ttsFirstByte - turnStart;
      log.info({ perceivedMs: +perceivedMs.toFixed(0) }, "First audio byte (perceived latency)");
    }

    if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: base64Audio },
        })
      );
    }
  });

  tts.on("flushed", () => {
    if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
      const markName = `tts-done-${++markCounter}`;
      twilioWs.send(
        JSON.stringify({
          event: "mark",
          streamSid,
          mark: { name: markName },
        })
      );
    }
  });

  tts.on("disconnected", () => {
    log.warn("TTS WebSocket disconnected — reconnecting");
  });

  tts.on("reconnected", (attempt: number) => {
    log.info({ attempt }, "TTS WebSocket reconnected");
  });

  tts.on("error", (err: Error) => {
    log.error({ err }, "TTS error");
  });

  twilioWs.on("message", (data) => {
    const msg: TwilioMessage = JSON.parse(data.toString());

    switch (msg.event) {
      case "connected":
        log.info("Twilio stream connected");
        // Pre-warm TTS connection while Twilio's <Say> message plays
        tts.start().catch((err) => log.error({ err }, "TTS pre-warm failed"));
        break;

      case "start": {
        streamSid = msg.start!.streamSid;
        callSid = msg.start!.callSid;

        const params = msg.start!.customParameters || {};
        const practiceId = params.practiceId || "";
        callerPhone = params.callerPhone || undefined;
        callLogId = params.callLogId || undefined;

        ctx = loadPracticeById(practiceId) || getFallbackPracticeContext();

        log.info(
          { streamSid, callSid, practiceId: ctx.id, practiceName: ctx.name, callerPhone },
          "Twilio stream started"
        );

        initPipeline();
        break;
      }

      case "media":
        if (msg.media?.payload) {
          const audioBuffer = Buffer.from(msg.media.payload, "base64");
          vad.processFrame(audioBuffer);
          stt.appendAudio(audioBuffer);
        }
        break;

      case "mark":
        if (msg.mark?.name.startsWith("tts-done-") && state === "speaking") {
          if (pendingTransfer) {
            executeTransfer(pendingTransfer.staffPhone);
            pendingTransfer = null;
            return;
          }
          if (pendingHangup && !hangingUp) {
            log.info("End-call tool triggered — hanging up");
            hangupGracefully();
            return;
          }
          state = "listening";
          resetSilenceTimer();
        }
        break;

      case "stop":
        log.info("Call ended");
        cleanup();
        break;
    }
  });

  twilioWs.on("close", () => {
    log.info("Twilio WebSocket closed");
    cleanup();
  });

  twilioWs.on("error", (err) => {
    log.error({ err }, "Twilio WebSocket error");
  });

  /** Enqueue an LLM turn — if one is already running, queue it for after. */
  function enqueueLLMTurn(utterance: string) {
    if (llmBusy) {
      // Merge with pending utterance if one exists
      if (pendingUtterance) {
        pendingUtterance += " " + utterance;
        log.info({ merged: pendingUtterance }, "Merged queued utterance");
      } else {
        pendingUtterance = utterance;
        log.info("LLM busy — utterance queued");
      }
      return;
    }
    runLLMTurn(utterance);
  }

  async function runLLMTurn(utterance: string) {
    llmBusy = true;
    await processLLMTurn(utterance);
    llmBusy = false;

    // Process queued utterance if any
    if (pendingUtterance) {
      const next = pendingUtterance;
      pendingUtterance = null;
      log.info({ queued: next }, "Processing queued utterance");
      runLLMTurn(next);
    }
  }

  async function processLLMTurn(userUtterance: string) {
    if (!userUtterance.trim() || !ctx) return;

    holdMessageSent = false;
    conversationHistory.push({ role: "user", content: userUtterance });
    logTranscript("user", userUtterance);

    try {
      const llmStart = performance.now();
      const abortController = new AbortController();
      const response = await generateResponse(
        conversationHistory,
        abortController.signal,
        ctx,
        toolCallbacks,
        log
      );
      currentResponse = response;

      const sentenceBuffer = new SentenceBuffer((sentence) => {
        tts.sendText(sentence);
      });

      let fullResponse = "";
      let firstToken = true;
      let firstSentenceTime: number | null = null;

      for await (const delta of response.textStream) {
        if (firstToken) {
          state = "speaking";
          const ttft = performance.now() - llmStart;
          log.info({ ttftMs: +ttft.toFixed(0) }, "LLM first token");
          firstToken = false;
        }
        if (state !== "speaking") {
          log.info("LLM interrupted");
          break;
        }
        sentenceBuffer.add(delta);
        fullResponse += delta;

        if (!firstSentenceTime && fullResponse.match(/[.!?]/)) {
          firstSentenceTime = performance.now() - llmStart;
          log.info({ firstSentenceMs: +firstSentenceTime.toFixed(0) }, "LLM first sentence sent to TTS");
        }
      }

      sentenceBuffer.flush();
      tts.flush();

      const llmTotalMs = performance.now() - llmStart;
      log.info({ llmTotalMs: +llmTotalMs.toFixed(0), responseLength: fullResponse.length, response: fullResponse }, "LLM complete");

      if (fullResponse) {
        conversationHistory.push({ role: "assistant", content: fullResponse });
        logTranscript("assistant", fullResponse);
      } else {
        let fallback: string;
        if (pendingHangup) {
          fallback = "Thank you for calling, have a great day!";
        } else if (callOutcome === "appointment_booked") {
          fallback = "Your appointment has been booked! Is there anything else I can help with?";
        } else {
          fallback = "I'm sorry, could you say that again?";
        }
        log.warn({ fallback, pendingHangup, callOutcome }, "LLM returned empty response — sending fallback");
        tts.sendText(fallback);
        tts.flush();
        conversationHistory.push({ role: "assistant", content: fallback });
        logTranscript("assistant", fallback);
        state = "speaking";
      }

      try {
        const finalText = await response.text;
        if (finalText && finalText !== fullResponse) {
          conversationHistory[conversationHistory.length - 1] = {
            role: "assistant",
            content: finalText,
          };
        }
      } catch {
        // Aborted
      }

      currentResponse = null;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        log.info("LLM aborted");
      } else {
        log.error({ err }, "LLM error");
        tts.sendText("I'm sorry, I'm having trouble right now. Could you please try again?");
        tts.flush();
        state = "speaking";
      }
    }
  }

  function handleInterruption() {
    if (currentResponse) {
      currentResponse.abort();
      currentResponse = null;
    }

    if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
    }

    tts.clear();
    pendingTransfer = null;
    pendingHangup = false;
    state = "listening";
    log.info("Interruption handled");
  }

  function cleanup() {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (currentResponse) {
      currentResponse.abort();
      currentResponse = null;
    }
    vad.removeAllListeners();
    tts.close();

    if (callSid) {
      try {
        updateCallLog(callSid, {
          streamSid: streamSid || undefined,
          outcome: callOutcome,
          outcomeDetails: callOutcomeDetails,
        });
      } catch (err) {
        log.error({ err }, "Failed to finalize call log outcome");
      }
    }

    log.info(
      { turns: conversationHistory.length, callSid, outcome: callOutcome },
      "Session cleaned up"
    );
  }
}
