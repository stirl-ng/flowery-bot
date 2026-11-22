/**
 * Discord sends 48 kHz stereo Opus. After decoding we get interleaved signed
 * 16-bit little-endian PCM; the speech model wants 16 kHz mono float32.
 */

export const DISCORD_SAMPLE_RATE = 48000;
export const DISCORD_CHANNELS = 2;
export const DISCORD_FRAME_SIZE = 960; // 20 ms at 48 kHz

/**
 * Converts 48 kHz stereo s16le PCM to 16 kHz mono float32.
 * Downmixes channels, then averages each group of 3 samples (a crude low-pass
 * that's plenty for speech recognition) to decimate 48k → 16k.
 */
export function discordPcmToStt(pcm: Buffer): Float32Array {
  const frameBytes = DISCORD_CHANNELS * 2;
  const inFrames = Math.floor(pcm.length / frameBytes);
  const outFrames = Math.floor(inFrames / 3);
  const out = new Float32Array(outFrames);

  for (let o = 0; o < outFrames; o++) {
    let sum = 0;
    for (let k = 0; k < 3; k++) {
      const offset = (o * 3 + k) * frameBytes;
      sum += pcm.readInt16LE(offset) + pcm.readInt16LE(offset + 2);
    }
    out[o] = sum / (6 * 32768);
  }
  return out;
}

/** Duration in seconds of a 48 kHz stereo s16le buffer. */
export function discordPcmSeconds(bytes: number): number {
  return bytes / (DISCORD_SAMPLE_RATE * DISCORD_CHANNELS * 2);
}
