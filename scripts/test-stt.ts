/**
 * Offline check of the whole listen → transcribe → reply pipeline, no Discord needed.
 *   npm run test-stt -- path/to/clip.wav [more.wav ...]          wake word → random clip
 *   npm run test-stt -- --llm path/to/clip.wav [...]             wake word → CLIP_PICKER (gemini/claude) picks
 * WAVs at 48 kHz stereo 16-bit go through the same conversion as Discord audio;
 * other formats are fed to the model as-is.
 */
import fs from 'node:fs';
import sherpa from 'sherpa-onnx-node';
import { discordPcmToStt } from '../src/audio.ts';
import { loadCatalog } from '../src/catalog.ts';
import { config } from '../src/config.ts';
import { createReplyPicker, RandomPicker } from '../src/picker.ts';
import { Responder } from '../src/responder.ts';
import { STT_SAMPLE_RATE, Transcriber } from '../src/stt.ts';
import { loadTriggers } from '../src/triggers.ts';

const args = process.argv.slice(2);
const useLlm = args.includes('--llm');
const files = args.filter((a) => a !== '--llm');
if (files.length === 0) {
  console.error('usage: npm run test-stt -- [--llm] clip.wav [...]');
  process.exit(1);
}

const transcriber = await Transcriber.load(config.modelDir);
const catalog = loadCatalog(config.catalogFile, config.voicelinesDir);
const random = new RandomPicker([...catalog.values()]);
const responder = new Responder({
  catalog,
  triggers: loadTriggers(config.triggersFile, catalog),
  wakeWords: config.wakeWords,
  threshold: config.wakeWordThreshold,
  maxClips: config.maxClips,
  picker: useLlm ? createReplyPicker(config, catalog, random) : random,
  fallback: random,
});

function isDiscordFormat(buf: Buffer): boolean {
  // Canonical WAV header: channels @22, sample rate @24, bits @34
  return buf.readUInt16LE(22) === 2 && buf.readUInt32LE(24) === 48000 && buf.readUInt16LE(34) === 16;
}

for (const file of files) {
  const raw = fs.readFileSync(file);
  let samples: Float32Array;
  if (isDiscordFormat(raw)) {
    samples = discordPcmToStt(raw.subarray(raw.indexOf('data') + 8));
  } else {
    const wave = sherpa.readWave(file);
    if (wave.sampleRate !== STT_SAMPLE_RATE) {
      console.warn(`${file}: ${wave.sampleRate} Hz, expected 16000 or 48000 stereo — results may be off`);
    }
    samples = wave.samples;
  }
  const t = Date.now();
  const text = await transcriber.transcribe(samples);
  const sttMs = Date.now() - t;
  const reply = await responder.respond('tester', text);
  const replyMs = Date.now() - t - sttMs;
  console.log(`${file.split(/[\\/]/).pop()}\n  heard: ${text}  (stt ${sttMs}ms)`);
  console.log(
    reply
      ? `  reply: [${reply.via}] ${reply.clips.map((c) => `${c.id} "${c.line}"`).join(' + ')}  (${replyMs}ms)`
      : '  reply: none',
  );
}
