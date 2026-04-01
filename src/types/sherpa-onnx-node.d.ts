declare module "sherpa-onnx-node" {
  interface SileroVadConfig {
    model: string;
    threshold: number;
    minSpeechDuration: number;
    minSilenceDuration: number;
    windowSize: number;
  }

  interface VadConfig {
    sileroVad: SileroVadConfig;
    sampleRate: number;
    debug: boolean;
    numThreads: number;
  }

  interface VadSegment {
    samples: Float32Array;
    start: number;
  }

  class Vad {
    config: VadConfig;
    constructor(config: VadConfig, bufferSizeSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isDetected(): boolean;
    isEmpty(): boolean;
    front(): VadSegment;
    pop(): void;
    clear(): void;
    reset(): void;
    flush(): void;
  }

  class CircularBuffer {
    constructor(capacity: number);
    push(samples: Float32Array): void;
    get(startIndex: number, length: number): Float32Array;
    pop(length: number): void;
    size(): number;
    head(): number;
  }

  const _default: {
    Vad: typeof Vad;
    CircularBuffer: typeof CircularBuffer;
  };

  export default _default;
  export { Vad, CircularBuffer, VadConfig, SileroVadConfig, VadSegment };
}
