import 'dotenv/config';
import path from 'node:path';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

export const config = {
  token: process.env.DISCORD_TOKEN ?? '',
  guildId: process.env.GUILD_ID?.trim() || undefined,
  wakeWords: (process.env.WAKE_WORDS ?? 'flowery')
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean),
  wakeWordThreshold: num('WAKE_WORD_THRESHOLD', 0.9),
  silenceMs: num('SILENCE_MS', 600),
  cooldownMs: num('COOLDOWN_MS', 1500),
  /** Utterances longer than this are trimmed to their last N seconds before transcription. */
  maxUtteranceSeconds: num('MAX_UTTERANCE_SECONDS', 15),
  /** Utterances shorter than this are ignored (coughs, clicks). */
  minUtteranceSeconds: num('MIN_UTTERANCE_SECONDS', 0.3),
  voicelinesDir: path.resolve(process.env.VOICELINES_DIR ?? 'voicelines/clean'),
  /** What each clip says — written by `npm run download-voicelines`. */
  catalogFile: path.resolve(process.env.CATALOG_FILE ?? 'voicelines/catalog.json'),
  /** Phrase → specific clip mappings. */
  triggersFile: path.resolve(process.env.TRIGGERS_FILE ?? 'triggers.json'),
  /** How to choose clips after the wake word: "gemini" or "claude" (LLM), or "random". */
  clipPicker: (process.env.CLIP_PICKER ?? 'gemini').trim().toLowerCase(),
  claudeModel: process.env.CLAUDE_MODEL?.trim() || 'claude-opus-5-5',
  claudeEffort: (process.env.CLAUDE_EFFORT?.trim() || 'low') as 'low' | 'medium' | 'high',
  geminiApiKey: (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '').trim(),
  geminiModel: process.env.GEMINI_MODEL?.trim() || 'gemini-flash-lite-latest',
  /** Most clips the LLM may chain into one reply. */
  maxClips: num('MAX_CLIPS', 3),
  modelDir: path.resolve(
    process.env.MODEL_DIR ?? 'models/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8',
  ),
  logTranscripts: bool('LOG_TRANSCRIPTS', true),
};

export type Config = typeof config;
