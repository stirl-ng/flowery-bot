import fs from 'node:fs';
import path from 'node:path';
import sherpa, { type OfflineRecognizer } from 'sherpa-onnx-node';

export const STT_SAMPLE_RATE = 16000;

/**
 * Offline (whole-utterance) speech-to-text using a local sherpa-onnx model.
 * Runs entirely on CPU, no API key or network needed.
 */
export class Transcriber {
  private constructor(private readonly recognizer: OfflineRecognizer) {}

  static async load(modelDir: string): Promise<Transcriber> {
    const file = (name: string) => {
      const p = path.join(modelDir, name);
      if (!fs.existsSync(p)) {
        throw new Error(`Missing speech model file ${p}. Run \`npm run download-model\` first.`);
      }
      return p;
    };

    const recognizer = await sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: STT_SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: file('encoder.int8.onnx'),
          decoder: file('decoder.int8.onnx'),
          joiner: file('joiner.int8.onnx'),
        },
        tokens: file('tokens.txt'),
        modelType: 'nemo_transducer',
        numThreads: 2,
        debug: false,
      },
    });
    return new Transcriber(recognizer);
  }

  /** @param samples mono float32 PCM at 16 kHz, range [-1, 1] */
  async transcribe(samples: Float32Array): Promise<string> {
    const stream = this.recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: STT_SAMPLE_RATE });
    const result = await this.recognizer.decodeAsync(stream);
    return result.text.trim();
  }
}
