/**
 * Fuzzy wake-word matching over a speech-to-text transcript.
 *
 * Speech recognizers rarely spell names consistently ("flowery", "flowerie",
 * "flower e"), so we compare letters only, ignoring
 * spaces and punctuation, and accept anything within an edit-distance ratio.
 */

export interface WakeWordMatch {
  wakeWord: string;
  /** The transcript words that matched. */
  heard: string;
  /** 0..1 similarity score. */
  score: number;
  /** Position of the match in the transcript, in words: [start, end). */
  start: number;
  end: number;
}

export function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/'/g, '')
    .split(/\s+/)
    .filter(Boolean);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - levenshtein(a, b) / longest;
}

/**
 * Returns the best wake-word match in the transcript, or null if none scores
 * at least `threshold`.
 */
export function findWakeWord(
  transcript: string,
  wakeWords: string[],
  threshold = 0.8,
): WakeWordMatch | null {
  const words = normalize(transcript);
  let best: WakeWordMatch | null = null;

  for (const wakeWord of wakeWords) {
    const target = normalize(wakeWord).join('');
    if (!target) continue;
    const targetWordCount = normalize(wakeWord).length;
    // Try windows of transcript words around the wake word's own length, since
    // the recognizer may split one word into two or merge two into one.
    const maxWindow = targetWordCount + 2;

    for (let start = 0; start < words.length; start++) {
      for (let len = 1; len <= maxWindow && start + len <= words.length; len++) {
        const heardWords = words.slice(start, start + len);
        const candidate = heardWords.join('');
        // Skip windows whose length is way off — they can't score well anyway.
        if (Math.abs(candidate.length - target.length) > target.length * (1 - threshold) + 1) {
          continue;
        }
        const score = similarity(candidate, target);
        if (score >= threshold && (!best || score > best.score)) {
          best = { wakeWord, heard: heardWords.join(' '), score, start, end: start + len };
        }
      }
    }
  }
  return best;
}
