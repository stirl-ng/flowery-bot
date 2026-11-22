import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Clip } from './catalog.ts';
import type { ClipPicker, PickRequest } from './picker.ts';
import { Responder } from './responder.ts';
import type { Trigger } from './triggers.ts';

const clip = (id: string): Clip => ({ id, line: id, usage: '', used: true, file: `${id}.wav` });
const catalog = new Map(['go-home', 'glue', 'hey-guys', 'jarona-1', 'jarona-2', 'smile-again'].map((id) => [id, clip(id)]));

const triggers: Trigger[] = [
  { phrases: ['flowery go home'], clips: ['go-home'] },
  { phrases: ['found a glue'], clips: ['hey-guys', 'glue'] },
  { phrases: ['flowery attack'], clips: ['jarona-1', 'jarona-2'], pick: 'random' },
];

class FakePicker implements ClipPicker {
  readonly name = 'fake';
  calls: PickRequest[] = [];
  constructor(private readonly result: string[] | Error) {}
  async pick(req: PickRequest) {
    this.calls.push(req);
    if (this.result instanceof Error) throw this.result;
    return this.result.map((id) => catalog.get(id)!);
  }
}

function responder(picker: ClipPicker) {
  return new Responder({
    catalog,
    triggers,
    wakeWords: ['flowery'],
    threshold: 0.9,
    picker,
    fallback: new FakePicker(['smile-again']),
  });
}

test('trigger phrase plays its clips in order, without asking the LLM', async () => {
  const llm = new FakePicker(['glue']);
  const reply = await responder(llm).respond('sam', 'hey I found a glue');
  assert.equal(reply?.via, 'trigger');
  assert.deepEqual(reply?.clips.map((c) => c.id), ['hey-guys', 'glue']);
  assert.equal(llm.calls.length, 0);
});

test('trigger with the wake word in it wins over the LLM', async () => {
  const reply = await responder(new FakePicker(['glue'])).respond('sam', 'Flowery, go home!');
  assert.deepEqual(reply?.clips.map((c) => c.id), ['go-home']);
});

test('pick: random plays exactly one of the clips', async () => {
  const reply = await responder(new FakePicker([])).respond('sam', 'flowery attack');
  assert.equal(reply?.clips.length, 1);
  assert.match(reply!.clips[0].id, /^jarona-/);
});

test('wake word sends the whole utterance to the LLM and plays its picks in order', async () => {
  const llm = new FakePicker(['hey-guys', 'smile-again']);
  const reply = await responder(llm).respond('sam', 'flowery cheer me up');
  assert.equal(reply?.via, 'llm');
  assert.deepEqual(reply?.clips.map((c) => c.id), ['hey-guys', 'smile-again']);
  assert.deepEqual(llm.calls, [{ speaker: 'sam', transcript: 'flowery cheer me up', recent: [] }]);
});

test('LLM failure falls back to a random clip', async () => {
  const reply = await responder(new FakePicker(new Error('timeout'))).respond('sam', 'flowery hi');
  assert.equal(reply?.via, 'random');
  assert.deepEqual(reply?.clips.map((c) => c.id), ['smile-again']);
});

test('no wake word and no trigger → no reply, no LLM call', async () => {
  const llm = new FakePicker(['glue']);
  assert.equal(await responder(llm).respond('sam', 'I bought some flowers'), null);
  assert.equal(llm.calls.length, 0);
});

test('several triggers in one sentence all play, in the order said', async () => {
  const r = new Responder({
    catalog: new Map([...catalog, ['blingo', clip('blingo')]]),
    triggers: [...triggers, { phrases: ['blingo blizzard'], clips: ['blingo'] }],
    wakeWords: ['flowery'],
    threshold: 0.9,
    picker: new FakePicker([]),
    fallback: new FakePicker([]),
    maxClips: 3,
  });
  const reply = await r.respond('sam', 'if I say flowery I found a glue and also blingo blizzard');
  assert.equal(reply?.via, 'trigger');
  assert.deepEqual(reply?.clips.map((c) => c.id), ['hey-guys', 'glue', 'blingo']);
});

test('overlapping triggers: the longer phrase wins over a word inside it', async () => {
  const r = new Responder({
    catalog,
    triggers: [{ phrases: ['glue'], clips: ['glue'] }, ...triggers],
    wakeWords: ['flowery'],
    threshold: 0.9,
    picker: new FakePicker([]),
    fallback: new FakePicker([]),
  });
  const reply = await r.respond('sam', 'I found a glue');
  assert.deepEqual(reply?.clips.map((c) => c.id), ['hey-guys', 'glue']);
});

test('recent clips are passed to the LLM', async () => {
  const llm = new FakePicker(['smile-again']);
  await responder(llm).respond('sam', 'flowery hi', ['hey-guys']);
  assert.deepEqual(llm.calls[0].recent, ['hey-guys']);
});
