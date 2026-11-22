// Minimal typings for the parts of sherpa-onnx-node this bot uses.
declare module 'sherpa-onnx-node' {
  export interface Waveform {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface OfflineStream {
    acceptWaveform(wave: Waveform): void;
  }

  export interface OfflineRecognizerResult {
    text: string;
    tokens?: string[];
    timestamps?: number[];
  }

  export class OfflineRecognizer {
    constructor(config: object);
    static createAsync(config: object): Promise<OfflineRecognizer>;
    createStream(hotwords?: string): OfflineStream;
    decode(stream: OfflineStream): void;
    decodeAsync(stream: OfflineStream): Promise<OfflineRecognizerResult>;
    getResult(stream: OfflineStream): OfflineRecognizerResult;
  }

  export function readWave(filename: string): Waveform;

  const sherpa: {
    OfflineRecognizer: typeof OfflineRecognizer;
    readWave: typeof readWave;
  };
  export default sherpa;
}
