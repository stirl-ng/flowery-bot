import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findWakeWord } from './wakeword.ts';

const WAKE = ['flowery'];
const T = 0.9; // the default threshold

test('matches exact wake word', () => {
  assert.equal(findWakeWord('hey flowery how are you', WAKE, T)?.wakeWord, 'flowery');
  assert.equal(findWakeWord('Hey, Flowery!', WAKE, T)?.heard, 'flowery');
});

test('ignores near-miss real words at the default threshold', () => {
  assert.equal(findWakeWord('I bought some flowers for my mom', WAKE, T), null);
  assert.equal(findWakeWord('that flower is pretty', WAKE, T), null);
  assert.equal(findWakeWord('the mailman came', WAKE, T), null);
  assert.equal(findWakeWord('', WAKE, T), null);
});

test('matches when recognizer splits or misspells a longer name', () => {
  const NAME = ['flowerman'];
  assert.equal(findWakeWord('Hey, Flow Erman!', NAME)?.heard, 'flow erman');
  assert.ok(findWakeWord('the flower men come here', NAME));
  assert.ok(findWakeWord('flowermann', NAME));
});

test('supports multiple wake words', () => {
  const m = findWakeWord('yo petal king', ['flowery', 'petal king'], T);
  assert.equal(m?.wakeWord, 'petal king');
});
