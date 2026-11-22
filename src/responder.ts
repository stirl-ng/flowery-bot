import type { Clip } from './catalog.ts';
import type { ClipPicker } from './picker.ts';
import { matchTriggers, type Trigger } from './triggers.ts';
import { findWakeWord } from './wakeword.ts';

export interface Reply {
  /** How the reply was chosen. */
  via: 'trigger' | 'llm' | 'random';
  /** The phrase/wake word that was heard. */
  heard: string;
  /** Clips to play, in order. */
  clips: Clip[];
}

interface Options {
  catalog: Map<string, Clip>;
  triggers: Trigger[];
  wakeWords: string[];
  threshold: number;
  picker: ClipPicker;
  fallback: ClipPicker;
  /** Most clips one reply may chain when several triggers are heard at once. */
  maxClips?: number;
}

/**
 * Decides what (if anything) Flowery says in response to an utterance:
 *
 * 1. Phrases from triggers.json → their specific clip(s), in the order said. Instant, no LLM.
 * 2. The wake word ("flowery …") → the picker (Claude) chooses 1+ clips that
 *    fit what was said. Falls back to a random clip if the picker fails.
 * 3. Anything else → silence.
 */
export class Responder {
  constructor(private readonly opts: Options) {}

  /** `recent`: ids of clips played lately in this channel, passed to the LLM so it varies its replies. */
  async respond(speaker: string, transcript: string, recent: string[] = []): Promise<Reply | null> {
    const { catalog, triggers, wakeWords, threshold, picker, fallback, maxClips = 3 } = this.opts;

    const matches = matchTriggers(transcript, triggers, catalog, threshold);
    if (matches.length) {
      return {
        via: 'trigger',
        heard: matches.map((m) => m.heard).join(' + '),
        clips: matches.flatMap((m) => m.clips).slice(0, Math.max(maxClips, matches[0].clips.length)),
      };
    }

    const wake = findWakeWord(transcript, wakeWords, threshold);
    if (!wake) return null;

    try {
      const clips = await picker.pick({ speaker, transcript, recent });
      if (clips.length) {
        return { via: picker === fallback ? 'random' : 'llm', heard: wake.heard, clips };
      }
      console.warn(`${picker.name} picked no clips; using a random one`);
    } catch (err) {
      console.warn(`${picker.name} failed (${(err as Error).message}); using a random clip`);
    }
    return { via: 'random', heard: wake.heard, clips: await fallback.pick({ speaker, transcript }) };
  }
}
