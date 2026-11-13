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
import { maybePrefetchAvailability } from "../pipeline/prefetch.js";
import type { PipelineState } from "../pipeline/types.js";
import { createCallDebugLogger } from "../lib/call-debug-log.js";

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

const MIN_TRANSCRIPT_WORDS = 2;
const MIN_TRANSCRIPT_LENGTH = 4;
const MULAW_SAMPLE_RATE = 8000;
const PRE_SPEECH_BUFFER_MS = 200;
const PRE_SPEECH_BUFFER_BYTES = Math.round((PRE_SPEECH_BUFFER_MS / 1000) * MULAW_SAMPLE_RATE);

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
  const normalizedWords = words
    .map((word) => word.toLowerCase().replace(/[^a-z0-9+]/g, ""))
    .filter(Boolean);
  if (normalizedWords.length >= 4) {
    let repeatedRun = 1;
    for (let i = 1; i < normalizedWords.length; i++) {
      if (normalizedWords[i] === normalizedWords[i - 1]) {
        repeatedRun++;
        if (repeatedRun >= 4) return true;
      } else {
        repeatedRun = 1;
      }
    }
  }
  if (normalizedWords.length >= 6) {
    const counts = new Map<string, number>();
    for (const word of normalizedWords) {
      counts.set(word, (counts.get(word) || 0) + 1);
    }
    const highestWordFrequency = Math.max(...counts.values());
    if (highestWordFrequency / normalizedWords.length >= 0.5) return true;
  }
  return false;
}

function getErrorDetails(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return { message: String(err) };
}

function sanitizeSpokenText(text: string): string {
  const cleaned = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\(?checking availability\)?$/i.test(line))
    .filter((line) => !/^(#+\s*)?step\s+\d+\s*:/i.test(line))
    .filter((line) => !/^check availability\b/i.test(line))
    .join(" ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^#+\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned;
}

function looksLikeE164PhoneNumber(phone: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(phone.trim());
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
  let mediaFrameCount = 0;
  let mediaBytes = 0;
  let sessionClosed = false;
  let capturingSpeech = false;
  let preSpeechAudioChunks: Buffer[] = [];
  let preSpeechAudioBytes = 0;

  const conversationHistory: ModelMessage[] = [];
  let currentResponse: StreamingLLMResponse | null = null;
  let callDebugLogger: ReturnType<typeof createCallDebugLogger> | null = null;
  const pendingCallEvents: Array<{
    event: string;
    data?: Record<string, unknown>;
    timestamp: string;
  }> = [];

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

  function logCallEvent(
    event: string,
    data?: Record<string, unknown>,
    timestamp = new Date().toISOString()
  ) {
    if (callDebugLogger) {
      callDebugLogger.logEvent(event, data, timestamp);
      return;
    }
    pendingCallEvents.push({ event, data, timestamp });
  }

  function clearPreSpeechBuffer() {
    preSpeechAudioChunks = [];
    preSpeechAudioBytes = 0;
  }

  function rememberPreSpeechAudio(chunk: Buffer) {
    preSpeechAudioChunks.push(chunk);
    preSpeechAudioBytes += chunk.length;

    while (preSpeechAudioBytes > PRE_SPEECH_BUFFER_BYTES && preSpeechAudioChunks.length > 0) {
      const evicted = preSpeechAudioChunks.shift();
      preSpeechAudioBytes -= evicted?.length ?? 0;
    }
  }

  function startSpeechCapture(includePreSpeech: boolean) {
    stt.clearBuffer();
    capturingSpeech = true;
    if (includePreSpeech) {
      for (const chunk of preSpeechAudioChunks) {
        stt.appendAudio(chunk);
      }
    }
    clearPreSpeechBuffer();
  }

  function resetSttCapture() {
    capturingSpeech = false;
    stt.clearBuffer();
    clearPreSpeechBuffer();
  }

  function initCallDebugLogger() {
    if (!callSid) return;

    if (!callDebugLogger) {
      callDebugLogger = createCallDebugLogger(
        {
          callSid,
          callLogId,
          callerPhone,
          practiceId: ctx?.id,
          practiceName: ctx?.name,
          streamSid: streamSid || undefined,
        },
        log
      );

      for (const pendingEvent of pendingCallEvents) {
        callDebugLogger.logEvent(pendingEvent.event, pendingEvent.data, pendingEvent.timestamp);
      }
      pendingCallEvents.length = 0;
      return;
    }

    callDebugLogger.setContext({
      callLogId,
      callerPhone,
      practiceId: ctx?.id,
      practiceName: ctx?.name,
      streamSid: streamSid || undefined,
    });
  }

  function logTranscript(role: string, content: string) {
    const sequence = ++transcriptSeq;
    logCallEvent("transcript_logged", {
      role,
      content,
      sequence,
      persistedToDatabase: Boolean(callLogId),
    });

    if (!callLogId) return;
    try {
      appendTranscriptTurn({
        callLogId,
        role,
        content,
        sequence,
      });
    } catch (err) {
      log.error({ err }, "Failed to log transcript turn");
      logCallEvent("transcript_persist_failed", {
        role,
        content,
        sequence,
        ...getErrorDetails(err),
      });
    }
  }

  // Hold messages before tool execution
  const TOOL_HOLD_MESSAGES: Record<string, string> = {
    check_availability: "Let me check that for you.",
    book_appointment: "One moment while I book that.",
  };
  let holdMessageSent = false;
  /** Twilio marks sent but not yet played back. A Set so marks returned after a clear are ignored. */
  const pendingMarks = new Set<string>();
  let pendingPlaybackFlushes = 0;
  let advanceOnPlaybackDrain = false;
  /** Bumped on every barge-in so the running LLM turn knows it was cut off. */
  let speechEpoch = 0;

  /** `cache` only for fixed phrases — LLM output can contain names and phone numbers. */
  function queueSpeech(text: string, cache = false) {
    if (sessionClosed) return;
    if (!text.trim()) return;
    logCallEvent("tts_text_queued", { text, cache });
    pendingPlaybackFlushes++;
    tts.speak(text, { cache });
  }

  /** Caller started talking over the assistant: stop playback and listen. */
  function interrupt() {
    speechEpoch++;
    log.info("Caller barged in — stopping playback");
    logCallEvent("barge_in", {
      pendingPlaybackFlushes,
      pendingMarks: pendingMarks.size,
      pendingHangup,
    });
    if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
    }
    tts.clear();
    currentResponse?.abort();
    pendingPlaybackFlushes = 0;
    pendingMarks.clear();
    advanceOnPlaybackDrain = false;
    // They have more to say, so don't hang up after the cut-off goodbye.
    pendingHangup = false;
    state = "listening";
    logCallEvent("state_changed", { state });
  }

  const toolCallbacks: ToolCallbacks = {
    onOutcome: (outcome, details) => {
      callOutcome = outcome;
      if (details) callOutcomeDetails = { ...callOutcomeDetails, ...details };
      logCallEvent("call_outcome_updated", {
        outcome,
        details,
      });
    },
    onTransfer: (staffPhone, reason) => {
      pendingTransfer = { staffPhone, reason };
      callOutcome = "transferred";
      callOutcomeDetails = { ...callOutcomeDetails, transferReason: reason };
      logCallEvent("transfer_requested", {
        staffPhone,
        reason,
      });
    },
    onEndCall: (reason) => {
      pendingHangup = true;
      if (callOutcome === "abandoned") callOutcome = "completed";
      callOutcomeDetails = { ...callOutcomeDetails, endReason: reason };
      logCallEvent("end_call_requested", { reason });
    },
    onToolStart: (toolName) => {
      const msg = TOOL_HOLD_MESSAGES[toolName];
      logCallEvent("tool_execution_started", { toolName, holdMessage: msg || null });
      if (msg && !holdMessageSent) {
        holdMessageSent = true;
        queueSpeech(msg, true);
      }
      // No barge-in while a tool runs: aborting mid-booking would book the slot
      // without ever confirming it to the caller.
      if (state === "speaking") {
        state = "thinking";
        logCallEvent("state_changed", { state });
      }
    },
    onBookingComplete: (details) => {
      // Send SMS confirmation after successful booking
      logCallEvent("booking_completed", details);
      const smsPhone = looksLikeE164PhoneNumber(details.patientPhone)
        ? details.patientPhone
        : callerPhone;

      if (smsPhone && ctx) {
        sendBookingConfirmationSms(smsPhone, details, ctx, log);
      }
    },
  };

  function completePlaybackIfReady() {
    if (sessionClosed) return;
    if (!advanceOnPlaybackDrain || pendingPlaybackFlushes > 0 || pendingMarks.size > 0) return;

    advanceOnPlaybackDrain = false;

    if (pendingTransfer) {
      logCallEvent("playback_drain_transfer");
      executeTransfer(pendingTransfer.staffPhone);
      pendingTransfer = null;
      return;
    }

    if (pendingHangup && !hangingUp) {
      log.info("End-call tool triggered — hanging up");
      logCallEvent("playback_drain_hangup");
      hangupGracefully();
      return;
    }

    state = "listening";
    logCallEvent("state_changed", { state });
    resetSilenceTimer();
  }

  function resetSilenceTimer() {
    if (sessionClosed) return;
    if (silenceTimer) clearTimeout(silenceTimer);
    silencePrompted = false;
    silenceTimer = setTimeout(() => {
      if (state === "listening") {
        if (!silencePrompted) {
          silencePrompted = true;
          logCallEvent("silence_prompt_triggered", {
            timeoutMs: env.SILENCE_TIMEOUT_MS,
          });
          queueSpeech("Are you still there?", true);
          state = "speaking";
          logCallEvent("state_changed", { state });
          advanceOnPlaybackDrain = true;
        } else {
          log.info("Silence timeout — hanging up");
          logCallEvent("silence_timeout_hangup", {
            timeoutMs: env.SILENCE_TIMEOUT_MS,
          });
          hangupGracefully();
        }
      }
    }, env.SILENCE_TIMEOUT_MS);
  }

  async function hangupGracefully() {
    if (hangingUp || !callSid) return;
    hangingUp = true;
    logCallEvent("hangup_started", { callSid });
    try {
      await twilioClient.calls(callSid).update({ status: "completed" });
      logCallEvent("hangup_completed", { callSid });
    } catch (err) {
      log.error({ err }, "Failed to hang up call via Twilio API");
      logCallEvent("hangup_failed", getErrorDetails(err));
    }
  }

  async function executeTransfer(staffPhone: string) {
    if (!callSid) return;
    logCallEvent("transfer_started", { staffPhone });
    try {
      const twiml = `<Response><Dial timeout="30">${staffPhone}</Dial><Say>I'm sorry, no one is available at the moment. Goodbye.</Say><Hangup/></Response>`;
      await twilioClient.calls(callSid).update({ twiml });
      log.info({ staffPhone }, "Call transferred to staff");
      logCallEvent("transfer_completed", { staffPhone, twiml });
    } catch (err) {
      log.error({ err }, "Failed to transfer call");
      logCallEvent("transfer_failed", {
        staffPhone,
        ...getErrorDetails(err),
      });
    }
  }

  async function initPipeline() {
    if (!ctx) return;
    try {
      const ttsWarmupStart = performance.now();
      void tts.start()
        .then(() => {
          if (sessionClosed) return;
          log.info({ ttsReadyMs: (performance.now() - ttsWarmupStart).toFixed(0) }, "TTS ready");
          logCallEvent("tts_ready", {
            ttsReadyMs: +(performance.now() - ttsWarmupStart).toFixed(0),
          });
        })
        .catch((err) => {
          if (sessionClosed) return;
          log.error({ err }, "Failed to initialize TTS");
          logCallEvent("pipeline_initialization_failed", getErrorDetails(err));
        });

      log.info("Pipeline initialized");
      logCallEvent("pipeline_initialized", {
        ttsWarmupStarted: true,
      });

      // Personalized greeting for returning callers
      const genericGreeting = `Thank you for calling ${ctx.name}. How can I help you today?`;
      let greeting = genericGreeting;
      if (callerPhone && ctx.id !== "__env_fallback__") {
        try {
          const patient = getPatientByPhone(ctx.id, callerPhone);
          if (patient?.name && patient.callCount > 1) {
            greeting = `Welcome back ${patient.name}! Thank you for calling ${ctx.name}. How can I help you today?`;
          }
        } catch {
          greeting = genericGreeting;
        }
      }

      // Generic greeting comes from the disk cache after the first call; the
      // personalized one contains a name, so it's synthesized each time.
      queueSpeech(greeting, greeting === genericGreeting);
      conversationHistory.push({ role: "assistant", content: greeting });
      logTranscript("assistant", greeting);
      state = "speaking";
      logCallEvent("state_changed", { state });
      advanceOnPlaybackDrain = true;
      log.info("Greeting sent");
    } catch (err) {
      log.error({ err }, "Failed to initialize pipeline");
      logCallEvent("pipeline_initialization_failed", getErrorDetails(err));
    }
  }

  vad.on("speechStart", () => {
    if (sessionClosed) return;
    if (state === "speaking") interrupt();
    if (state !== "listening") return;
    if (silenceTimer) clearTimeout(silenceTimer);
    logCallEvent("speech_started", { state });
    startSpeechCapture(true);
    state = "listening";
    logCallEvent("state_changed", { state });
  });

  vad.on("speechEnd", async (durationSecs: number) => {
    if (sessionClosed) return;
    turnStart = performance.now();
    ttsFirstByte = null;
    capturingSpeech = false;
    const bufferedAudioDurationS = stt.getBufferDuration();
    clearPreSpeechBuffer();

    logCallEvent("speech_ended", {
      speechDurationS: +durationSecs.toFixed(1),
      bufferedAudioDurationS: +bufferedAudioDurationS.toFixed(1),
    });

    if (bufferedAudioDurationS < 0.5) {
      resetSttCapture();
      state = "listening";
      logCallEvent("short_audio_discarded", {
        audioDurationS: +bufferedAudioDurationS.toFixed(1),
      });
      logCallEvent("state_changed", { state });
      resetSilenceTimer();
      return;
    }

    state = "thinking";
    logCallEvent("state_changed", { state });
    log.info({ speechDurationS: durationSecs.toFixed(1), audioDurationS: stt.getBufferDuration().toFixed(1) }, "Speech ended, transcribing");

    try {
      const sttStart = performance.now();
      logCallEvent("stt_started", {
        audioDurationS: +stt.getBufferDuration().toFixed(1),
      });
      const transcript = await stt.transcribe();
      const sttMs = performance.now() - sttStart;

      if (sessionClosed) {
        return;
      }

      if (!transcript) {
        log.info({ sttMs: +sttMs.toFixed(0) }, "Empty transcript");
        logCallEvent("stt_empty", { sttMs: +sttMs.toFixed(0) });
        state = "listening";
        logCallEvent("state_changed", { state });
        resetSilenceTimer();
        return;
      }

      // Filter garbage transcripts
      if (isGarbageTranscript(transcript)) {
        log.info({ transcript, sttMs: +sttMs.toFixed(0) }, "Garbage transcript filtered");
        logCallEvent("stt_garbage_filtered", {
          transcript,
          sttMs: +sttMs.toFixed(0),
        });
        state = "listening";
        logCallEvent("state_changed", { state });
        resetSilenceTimer();
        return;
      }

      log.info({ transcript, sttMs: +sttMs.toFixed(0) }, "STT complete");
      logCallEvent("stt_completed", {
        transcript,
        sttMs: +sttMs.toFixed(0),
      });

      // Speculatively prefetch availability if transcript looks like a scheduling request
      if (ctx) {
        const prefetched = maybePrefetchAvailability(transcript, ctx);
        if (prefetched) {
          log.info("Speculative availability prefetch started");
          logCallEvent("availability_prefetch_started", { transcript });
        }
      }

      enqueueLLMTurn(transcript);
    } catch (err) {
      log.error({ err }, "STT failed");
      logCallEvent("stt_failed", getErrorDetails(err));
      queueSpeech("I'm sorry, I didn't catch that. Could you please repeat?", true);
      state = "speaking";
      logCallEvent("state_changed", { state });
      advanceOnPlaybackDrain = true;
    }
  });

  tts.on("audio", (base64Audio: string) => {
    if (turnStart && !ttsFirstByte) {
      ttsFirstByte = performance.now();
      const perceivedMs = ttsFirstByte - turnStart;
      log.info({ perceivedMs: +perceivedMs.toFixed(0) }, "First audio byte (perceived latency)");
      logCallEvent("tts_first_audio_byte", {
        perceivedMs: +perceivedMs.toFixed(0),
      });
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
    logCallEvent("tts_flushed", {
      pendingPlaybackFlushes,
      pendingMarks: pendingMarks.size,
    });
    if (pendingPlaybackFlushes > 0) {
      pendingPlaybackFlushes--;
    }

    if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
      const markName = `tts-done-${++markCounter}`;
      pendingMarks.add(markName);
      twilioWs.send(
        JSON.stringify({
          event: "mark",
          streamSid,
          mark: { name: markName },
        })
      );
      return;
    }

    completePlaybackIfReady();
  });

  tts.on("disconnected", () => {
    log.warn("TTS WebSocket disconnected — reconnecting");
    logCallEvent("tts_disconnected");
  });

  tts.on("reconnected", (attempt: number) => {
    log.info({ attempt }, "TTS WebSocket reconnected");
    logCallEvent("tts_reconnected", { attempt });
  });

  tts.on("error", (err: Error) => {
    log.error({ err }, "TTS error");
    logCallEvent("tts_error", getErrorDetails(err));
  });

  twilioWs.on("message", (data) => {
    const msg: TwilioMessage = JSON.parse(data.toString());

    switch (msg.event) {
      case "connected":
        log.info("Twilio stream connected");
        logCallEvent("twilio_stream_connected");
        // Open the TTS socket before the start event arrives
        tts.start().catch((err) => {
          log.error({ err }, "TTS pre-warm failed");
          logCallEvent("tts_prewarm_failed", getErrorDetails(err));
        });
        break;

      case "start": {
        streamSid = msg.start!.streamSid;
        callSid = msg.start!.callSid;

        const params = msg.start!.customParameters || {};
        const practiceId = params.practiceId || "";
        callerPhone = params.callerPhone || undefined;
        callLogId = params.callLogId || undefined;

        ctx = loadPracticeById(practiceId) || getFallbackPracticeContext();
        initCallDebugLogger();

        log.info(
          { streamSid, callSid, practiceId: ctx.id, practiceName: ctx.name, callerPhone },
          "Twilio stream started"
        );
        logCallEvent("twilio_stream_started", {
          streamSid,
          practiceId: ctx.id,
          practiceName: ctx.name,
          callerPhone,
          customParameters: params,
        });

        initPipeline();
        break;
      }

      case "media":
        if (msg.media?.payload) {
          const audioBuffer = Buffer.from(msg.media.payload, "base64");
          mediaFrameCount++;
          mediaBytes += audioBuffer.length;
          if (sessionClosed) break;
          // While speaking, keep listening so the caller can interrupt.
          const canHear = state === "listening" || (state === "speaking" && env.BARGE_IN_ENABLED);
          if (!canHear) {
            resetSttCapture();
            break;
          }
          vad.processFrame(audioBuffer);
          if (capturingSpeech) {
            stt.appendAudio(audioBuffer);
          } else {
            rememberPreSpeechAudio(audioBuffer);
          }
        }
        break;

      case "mark":
        if (msg.mark?.name.startsWith("tts-done-")) {
          logCallEvent("twilio_mark_received", {
            markName: msg.mark.name,
          });
          pendingMarks.delete(msg.mark.name);
          completePlaybackIfReady();
        }
        break;

      case "stop":
        log.info("Call ended");
        logCallEvent("twilio_stream_stopped");
        cleanup();
        break;
    }
  });

  twilioWs.on("close", () => {
    log.info("Twilio WebSocket closed");
    logCallEvent("twilio_websocket_closed");
    cleanup();
  });

  twilioWs.on("error", (err) => {
    log.error({ err }, "Twilio WebSocket error");
    logCallEvent("twilio_websocket_error", getErrorDetails(err));
  });

  /** Enqueue an LLM turn — if one is already running, queue it for after. */
  function enqueueLLMTurn(utterance: string) {
    if (sessionClosed) return;
    if (llmBusy) {
      // Merge with pending utterance if one exists
      if (pendingUtterance) {
        pendingUtterance += " " + utterance;
        log.info({ merged: pendingUtterance }, "Merged queued utterance");
        logCallEvent("llm_utterance_merged", {
          mergedUtterance: pendingUtterance,
        });
      } else {
        pendingUtterance = utterance;
        log.info("LLM busy — utterance queued");
        logCallEvent("llm_utterance_queued", { utterance });
      }
      return;
    }
    logCallEvent("llm_turn_started", { utterance });
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
      logCallEvent("llm_queued_turn_processing", { utterance: next });
      runLLMTurn(next);
    }
  }

  async function processLLMTurn(userUtterance: string) {
    if (sessionClosed) return;
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
        log,
        callDebugLogger ?? undefined
      );
      if (sessionClosed) {
        abortController.abort();
        return;
      }
      currentResponse = response;
      logCallEvent("llm_generation_started", {
        utterance: userUtterance,
        historyLength: conversationHistory.length,
      });

      let firstSentenceTime: number | null = null;
      const sentenceBuffer = new SentenceBuffer((sentence) => {
        const spokenSentence = sanitizeSpokenText(sentence);
        if (!spokenSentence) return;
        if (!firstSentenceTime) {
          firstSentenceTime = performance.now() - llmStart;
          log.info({ firstSentenceMs: +firstSentenceTime.toFixed(0) }, "LLM first sentence sent to TTS");
          logCallEvent("llm_first_sentence", {
            firstSentenceMs: +firstSentenceTime.toFixed(0),
          });
        }
        queueSpeech(spokenSentence);
      });

      let fullResponse = "";
      let firstToken = true;
      const epoch = speechEpoch;
      const wasInterrupted = () => epoch !== speechEpoch;

      try {
        for await (const delta of response.textStream) {
          if (wasInterrupted()) break;
          if (firstToken) {
            const ttft = performance.now() - llmStart;
            log.info({ ttftMs: +ttft.toFixed(0) }, "LLM first token");
            logCallEvent("llm_first_token", { ttftMs: +ttft.toFixed(0) });
            firstToken = false;
          }
          // Also re-entered after a tool call put us back in "thinking".
          if (state !== "speaking") {
            state = "speaking";
            logCallEvent("state_changed", { state });
          }
          sentenceBuffer.add(delta);
          fullResponse += delta;
        }
      } catch (err) {
        if (!wasInterrupted()) throw err; // aborting the stream on barge-in may throw
      }

      if (wasInterrupted()) {
        // Keep what was generated so the model knows where it got cut off.
        // Tool results from this turn are lost with the aborted stream.
        const partial = sanitizeSpokenText(fullResponse);
        log.info({ partial }, "LLM interrupted by caller");
        logCallEvent("llm_interrupted", { partialResponse: partial });
        if (partial) {
          conversationHistory.push({ role: "assistant", content: partial });
          logTranscript("assistant", partial);
        }
        currentResponse = null;
        return;
      }

      sentenceBuffer.flush();

      const llmTotalMs = performance.now() - llmStart;
      log.info({ llmTotalMs: +llmTotalMs.toFixed(0), responseLength: fullResponse.length, response: fullResponse }, "LLM complete");
      logCallEvent("llm_completed", {
        llmTotalMs: +llmTotalMs.toFixed(0),
        responseLength: fullResponse.length,
        response: fullResponse,
      });

      const spokenResponse = sanitizeSpokenText(fullResponse);

      // Assistant tool calls + tool results, so later turns still know which
      // slots were offered instead of re-checking or inventing them.
      let responseMessages: ModelMessage[] = [];
      try {
        responseMessages = await response.responseMessages();
      } catch (err) {
        logCallEvent("llm_response_messages_failed", getErrorDetails(err));
      }

      if (spokenResponse) {
        if (responseMessages.length > 0) {
          conversationHistory.push(...responseMessages);
        } else {
          conversationHistory.push({ role: "assistant", content: spokenResponse });
        }
        logTranscript("assistant", spokenResponse);
        advanceOnPlaybackDrain = true;
        completePlaybackIfReady();
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
        logCallEvent("llm_empty_response_fallback", {
          fallback,
          pendingHangup,
          callOutcome,
        });
        queueSpeech(fallback, true);
        conversationHistory.push(...responseMessages, { role: "assistant", content: fallback });
        logTranscript("assistant", fallback);
        state = "speaking";
        logCallEvent("state_changed", { state });
        advanceOnPlaybackDrain = true;
        completePlaybackIfReady();
      }

      currentResponse = null;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        log.info("LLM aborted");
        logCallEvent("llm_aborted");
      } else {
        log.error({ err }, "LLM error");
        logCallEvent("llm_error", getErrorDetails(err));
        queueSpeech("I'm sorry, I'm having trouble right now. Could you please try again?", true);
        state = "speaking";
        logCallEvent("state_changed", { state });
        advanceOnPlaybackDrain = true;
        completePlaybackIfReady();
      }
    }
  }

  function cleanup() {
    if (sessionClosed) return;
    sessionClosed = true;
    if (silenceTimer) clearTimeout(silenceTimer);
    if (currentResponse) {
      currentResponse.abort();
      currentResponse = null;
      logCallEvent("llm_abort_requested_for_cleanup");
    }
    pendingMarks.clear();
    pendingPlaybackFlushes = 0;
    advanceOnPlaybackDrain = false;
    resetSttCapture();
    vad.reset();
    vad.removeAllListeners();
    tts.close();
    logCallEvent("media_stream_summary", {
      mediaFrameCount,
      mediaBytes,
      turns: conversationHistory.length,
    });

    if (callSid) {
      try {
        updateCallLog(callSid, {
          streamSid: streamSid || undefined,
          outcome: callOutcome,
          outcomeDetails: callOutcomeDetails,
        });
        logCallEvent("call_log_finalized", {
          streamSid,
          outcome: callOutcome,
          outcomeDetails: callOutcomeDetails,
        });
      } catch (err) {
        log.error({ err }, "Failed to finalize call log outcome");
        logCallEvent("call_log_finalize_failed", getErrorDetails(err));
      }
    }

    log.info(
      { turns: conversationHistory.length, callSid, outcome: callOutcome },
      "Session cleaned up"
    );
    logCallEvent("session_cleaned_up", {
      turns: conversationHistory.length,
      callSid,
      outcome: callOutcome,
    });
    callDebugLogger?.close();
  }
}
