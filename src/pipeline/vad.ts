import { EventEmitter } from "events";
import sherpa from "sherpa-onnx-node";
const { Vad, CircularBuffer } = sherpa;
import alawmulaw from "alawmulaw";
const { mulaw } = alawmulaw;
import path from "path";

const MODEL_PATH = path.resolve(process.cwd(), "models", "silero_vad.onnx");
const SAMPLE_RATE = 16000;
const WINDOW_SIZE = 512;

/**
 * Silero VAD via sherpa-onnx-node.
 * Converts mulaw 8kHz → float32 16kHz, detects speech boundaries.
 * Emits: "speechStart", "speechEnd"
 */
export class SileroVAD extends EventEmitter {
  private vad: InstanceType<typeof Vad>;
  private buffer: InstanceType<typeof CircularBuffer>;
  private detected = false;

  constructor() {
    super();
    this.vad = new Vad(
      {
        sileroVad: {
          model: MODEL_PATH,
          threshold: 0.5,
          minSpeechDuration: 0.25,
          minSilenceDuration: 0.4,
          windowSize: WINDOW_SIZE,
        },
        sampleRate: SAMPLE_RATE,
        debug: false,
        numThreads: 1,
      },
      60
    );
    this.buffer = new CircularBuffer(30 * SAMPLE_RATE);
  }

  processFrame(mulawFrame: Buffer): void {
    const int16Samples = mulaw.decode(new Uint8Array(mulawFrame));

    // Upsample 8kHz → 16kHz via linear interpolation
    const upsampled = new Float32Array(int16Samples.length * 2);
    for (let i = 0; i < int16Samples.length; i++) {
      const sample = int16Samples[i] / 32768.0;
      upsampled[i * 2] = sample;
      upsampled[i * 2 + 1] =
        i < int16Samples.length - 1
          ? (sample + int16Samples[i + 1] / 32768.0) / 2
          : sample;
    }

    this.buffer.push(upsampled);

    while (this.buffer.size() > WINDOW_SIZE) {
      const samples = this.buffer.get(this.buffer.head(), WINDOW_SIZE);
      this.buffer.pop(WINDOW_SIZE);
      this.vad.acceptWaveform(samples);

      if (this.vad.isDetected() && !this.detected) {
        this.detected = true;
        this.emit("speechStart");
      }
      if (!this.vad.isDetected()) {
        this.detected = false;
      }

      while (!this.vad.isEmpty()) {
        const segment = this.vad.front();
        this.vad.pop();
        this.emit("speechEnd", segment.samples.length / SAMPLE_RATE);
      }
    }
  }

  reset(): void {
    this.vad.reset();
    this.detected = false;
  }

  flush(): void {
    this.vad.flush();
    while (!this.vad.isEmpty()) {
      const segment = this.vad.front();
      this.vad.pop();
      this.emit("speechEnd", segment.samples.length / SAMPLE_RATE);
    }
  }
}
