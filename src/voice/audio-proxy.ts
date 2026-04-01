import WebSocket from "ws";
import type { FastifyBaseLogger } from "fastify";
import type { ModelMessage } from "ai";
import { env } from "../config/env.js";
import { SileroVAD } from "../pipeline/vad.js";
import { GroqSTT } from "../pipeline/stt.js";
import { DeepgramTTS } from "../pipeline/tts.js";
import { SentenceBuffer } from "../pipeline/sentence-buffer.js";
import { generateResponse, type StreamingLLMResponse } from "../pipeline/llm.js";
import type { PipelineState } from "../pipeline/types.js";

interface TwilioMessage {
  event: string;
  streamSid?: string;
  start?: { streamSid: string; callSid: string };
  media?: { payload: string };
  mark?: { name: string };
}

/**
 * Pipeline orchestrator for a single phone call.
 * Flow: Twilio audio -> Silero VAD -> Groq Whisper STT -> Groq LLM -> Deepgram TTS -> Twilio
 */
export function handleMediaStream(twilioWs: WebSocket, log: FastifyBaseLogger) {
  let streamSid: string | null = null;
  let callSid: string | null = null;
  let state: PipelineState = "idle";
  let markCounter = 0;

  // Tracks the start of the current turn (from speech end to first audio back)
  let turnStart: number | null = null;
  let ttsFirstByte: number | null = null;

  const conversationHistory: ModelMessage[] = [];
  let currentResponse: StreamingLLMResponse | null = null;

  const vad = new SileroVAD();
  const stt = new GroqSTT();
  const tts = new DeepgramTTS();

  async function initPipeline() {
    try {
      const ttsConnStart = performance.now();
      await tts.start();
      log.info({ ttsConnMs: (performance.now() - ttsConnStart).toFixed(0) }, "Pipeline initialized");

      const greeting = `Thank you for calling ${env.PRACTICE_NAME}. How can I help you today?`;
      tts.sendText(greeting);
      tts.flush();
      conversationHistory.push({ role: "assistant", content: greeting });
      state = "speaking";
      log.info("Greeting sent");
    } catch (err) {
      log.error({ err }, "Failed to initialize pipeline");
    }
  }

  vad.on("speechStart", () => {
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
      return;
    }

    state = "thinking";
    log.info({ speechDurationS: durationSecs.toFixed(1), audioDurationS: stt.getBufferDuration().toFixed(1) }, "Speech ended, transcribing");

    try {
      const sttStart = performance.now();
      const transcript = await stt.transcribe();
      const sttMs = performance.now() - sttStart;

      if (transcript) {
        log.info({ transcript, sttMs: +sttMs.toFixed(0) }, "STT complete");
        processLLMTurn(transcript);
      } else {
        log.info({ sttMs: +sttMs.toFixed(0) }, "Empty transcript");
        state = "listening";
      }
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

  tts.on("error", (err: Error) => {
    log.error({ err }, "TTS error");
  });

  twilioWs.on("message", (data) => {
    const msg: TwilioMessage = JSON.parse(data.toString());

    switch (msg.event) {
      case "connected":
        log.info("Twilio stream connected");
        break;

      case "start":
        streamSid = msg.start!.streamSid;
        callSid = msg.start!.callSid;
        log.info({ streamSid, callSid }, "Twilio stream started");
        initPipeline();
        break;

      case "media":
        if (msg.media?.payload) {
          const audioBuffer = Buffer.from(msg.media.payload, "base64");
          vad.processFrame(audioBuffer);
          stt.appendAudio(audioBuffer);
        }
        break;

      case "mark":
        if (msg.mark?.name.startsWith("tts-done-") && state === "speaking") {
          state = "listening";
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

  async function processLLMTurn(userUtterance: string) {
    if (!userUtterance.trim()) return;

    conversationHistory.push({ role: "user", content: userUtterance });

    try {
      const llmStart = performance.now();
      const abortController = new AbortController();
      const response = await generateResponse(conversationHistory, abortController.signal);
      currentResponse = response;
      state = "speaking";

      const sentenceBuffer = new SentenceBuffer((sentence) => {
        tts.sendText(sentence);
      });

      let fullResponse = "";
      let firstToken = true;
      let firstSentenceTime: number | null = null;

      for await (const delta of response.textStream) {
        if (state !== "speaking") {
          log.info("LLM interrupted");
          break;
        }
        if (firstToken) {
          const ttft = performance.now() - llmStart;
          log.info({ ttftMs: +ttft.toFixed(0) }, "LLM first token");
          firstToken = false;
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
      log.info({ llmTotalMs: +llmTotalMs.toFixed(0), responseLength: fullResponse.length }, "LLM complete");

      if (fullResponse) {
        conversationHistory.push({ role: "assistant", content: fullResponse });
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
    state = "listening";
    log.info("Interruption handled");
  }

  function cleanup() {
    if (currentResponse) {
      currentResponse.abort();
      currentResponse = null;
    }
    vad.removeAllListeners();
    tts.close();
    log.info({ turns: conversationHistory.length, callSid }, "Session cleaned up");
  }
}
