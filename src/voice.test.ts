import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Clip } from './catalog.ts';
import type { ClipPicker } from './picker.ts';
import { cleanLine, TtsClient, VoicePicker, type LineWriter } from './voice.ts';

const gameClip: Clip = { id: 'smile-again', line: 'Smile again', usage: '', used: true, file: 'smile-again.wav' };
const fallback: ClipPicker = { name: 'clips', pick: async () => [gameClip] };
const writer = (line: string | Error): LineWriter => ({
  name: 'fake',
  write: async () => {
    if (line instanceof Error) throw line;
    return line;
  },
});
const tts = (result: Buffer | Error) =>
  ({
    speak: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  }) as unknown as TtsClient;

test('cleanLine strips what TTS would read badly', () => {
  assert.equal(cleanLine('Flowery: "Leaf it to me!" *winks* 🌸'), 'Leaf it to me!');
  assert.equal(cleanLine('Hey (smugly) little guy.'), 'Hey little guy.');
});

test('cleanLine trims long replies at a sentence end', () => {
  const long = `${'All according to plant. '.repeat(12)}`;
  const out = cleanLine(long);
  assert.ok(out.length <= 200);
  assert.ok(out.endsWith('.'));
});

test('voice picker returns the spoken line as a playable clip', async () => {
  const picker = new VoicePicker(writer('Leaf it to me!'), tts(Buffer.from('RIFF')), fallback);
  const [clip] = await picker.pick({ speaker: 'kris', transcript: 'flowery help' });
  assert.equal(clip.line, 'Leaf it to me!');
  assert.ok(fs.existsSync(clip.file));
});

test('voice picker falls back to game clips when TTS fails', async () => {
  const picker = new VoicePicker(writer('Hi'), tts(new Error('connection refused')), fallback);
  assert.deepEqual(await picker.pick({ speaker: 'kris', transcript: 'flowery' }), [gameClip]);
});

test('voice picker falls back when the writer returns nothing usable', async () => {
  const picker = new VoicePicker(writer('*waves*'), tts(Buffer.from('RIFF')), fallback);
  assert.deepEqual(await picker.pick({ speaker: 'kris', transcript: 'flowery' }), [gameClip]);
});
