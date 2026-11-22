import fs from 'node:fs';
import type { Clip } from './catalog.ts';
import { findWakeWord } from './wakeword.ts';

/**
 * A phrase that plays a specific clip, no LLM involved. Defined in triggers.json:
 *
 *   { "phrases": ["san francisco"], "clips": ["here-i-come-san-frandisco"] }
 *
 * - `phrases`: any of these heard anywhere in an utterance fires the trigger.
 *   If several triggers are heard in one utterance, all of them play in spoken order.
 * - `clips`: played in order (one reply made of several clips).
 *   Use `pick: "random"` to play just one of them at random instead.
 * - `threshold`: optional per-trigger fuzziness (defaults to WAKE_WORD_THRESHOLD).
 */
export interface Trigger {
  phrases: string[];
  clips: string[];
  pick?: 'all' | 'random';
  threshold?: number;
}

export interface TriggerMatch {
  trigger: Trigger;
  heard: string;
  phrase: string;
  clips: Clip[];
}

export function loadTriggers(file: string, catalog: Map<string, Clip>): Trigger[] {
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { triggers?: Trigger[] };
  const triggers = raw.triggers ?? [];
  for (const t of triggers) {
    const missing = t.clips.filter((id) => !catalog.has(id));
    if (missing.length) {
      console.warn(`triggers: "${t.phrases[0]}" refers to unknown clip(s): ${missing.join(', ')}`);
    }
  }
  return triggers.filter((t) => t.phrases?.length && t.clips.some((id) => catalog.has(id)));
}

/**
 * Returns every trigger heard in the transcript, in the order they were said.
 * Where two triggers match the same words (e.g. "glue" inside "i found a glue"),
 * the better match wins, and on a tie the longer phrase.
 */
export function matchTriggers(
  transcript: string,
  triggers: Trigger[],
  catalog: Map<string, Clip>,
  defaultThreshold: number,
): TriggerMatch[] {
  const candidates = triggers.flatMap((trigger) => {
    const m = findWakeWord(transcript, trigger.phrases, trigger.threshold ?? defaultThreshold);
    return m ? [{ trigger, m }] : [];
  });
  candidates.sort((a, b) => b.m.score - a.m.score || b.m.end - b.m.start - (a.m.end - a.m.start));

  const kept: typeof candidates = [];
  for (const c of candidates) {
    if (kept.every((k) => c.m.end <= k.m.start || c.m.start >= k.m.end)) kept.push(c);
  }
  kept.sort((a, b) => a.m.start - b.m.start);

  return kept.map(({ trigger, m }) => {
    let clips = trigger.clips.map((id) => catalog.get(id)).filter((c): c is Clip => !!c);
    if (trigger.pick === 'random') clips = [clips[Math.floor(Math.random() * clips.length)]];
    return { trigger, heard: m.heard, phrase: m.wakeWord, clips };
  });
}
