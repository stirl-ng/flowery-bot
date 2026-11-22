import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Clip } from './catalog.ts';
import type { ClipPicker, PickRequest } from './picker.ts';

/**
 * Generated replies: an LLM writes a new line in Flowery's style, and the local
 * F5-TTS server (tts/server.py) speaks it in his cloned voice.
 */

/** Writes the words of a reply. */
export interface LineWriter {
  readonly name: string;
  write(req: PickRequest, recentLines: string[]): Promise<string>;
}

export class GeminiWriter implements LineWriter {
  readonly name: string;
  private readonly client: GoogleGenAI;
  private readonly system: string;

  constructor(clips: Clip[], private readonly opts: { apiKey: string; model: string }) {
    this.name = `gemini (${opts.model})`;
    this.client = new GoogleGenAI({ apiKey: opts.apiKey, httpOptions: { timeout: 15_000 } });
    this.system = buildWriterPrompt(clips);
  }

  async write(req: PickRequest, recentLines: string[]): Promise<string> {
    const response = await this.client.models.generateContent({
      model: this.opts.model,
      contents: writerMessage(req, recentLines),
      config: { systemInstruction: this.system },
    });
    return response.text ?? '';
  }
}

export class ClaudeWriter implements LineWriter {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly system: string;

  constructor(clips: Clip[], private readonly opts: { model: string; effort: 'low' | 'medium' | 'high' }) {
    this.name = `claude (${opts.model})`;
    this.client = new Anthropic({ timeout: 15_000, maxRetries: 1 });
    this.system = buildWriterPrompt(clips);
  }

  async write(req: PickRequest, recentLines: string[]): Promise<string> {
    // Retry on a fallback model if a safety classifier declines (transcripts are arbitrary speech).
    const fallback = /^claude-(opus-5|sonnet-5-5|fable-5)/.test(this.opts.model)
      ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
      : {};
    const response = await this.client.beta.messages.create({
      ...fallback,
      model: this.opts.model,
      max_tokens: 1024,
      output_config: { effort: this.opts.effort },
      // The prompt is identical on every request, so cache it.
      system: [{ type: 'text', text: this.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: writerMessage(req, recentLines) }],
    });
    if (response.stop_reason === 'refusal') return '';
    return response.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  }
}

/** Talks to tts/server.py. */
export class TtsClient {
  constructor(private readonly opts: { url: string; crunch: boolean; timeoutMs: number }) {}

  async speak(text: string): Promise<Buffer> {
    const res = await fetch(`${this.opts.url}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, crunch: this.opts.crunch }),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) throw new Error(`TTS server HTTP ${res.status}: ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.opts.url}/health`, { signal: AbortSignal.timeout(2_000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Replies with a newly written and spoken line. If writing or speaking fails,
 * it hands the request to `fallback` (normally the LLM clip picker), so Flowery
 * still answers with a game clip.
 */
export class VoicePicker implements ClipPicker {
  readonly name: string;
  private readonly dir = path.join(os.tmpdir(), 'flowery-bot-tts');
  private readonly files: string[] = [];
  private recentLines: string[] = [];
  private count = 0;

  constructor(
    private readonly writer: LineWriter,
    private readonly tts: TtsClient,
    private readonly fallback: ClipPicker,
  ) {
    this.name = `voice (${writer.name} + f5-tts)`;
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
  }

  async pick(req: PickRequest): Promise<Clip[]> {
    try {
      const line = cleanLine(await this.writer.write(req, this.recentLines));
      if (!line) throw new Error('the writer returned no line');
      const audio = await this.tts.speak(line);
      this.recentLines = [...this.recentLines, line].slice(-6);
      return [{ id: 'generated', line, usage: '', used: true, file: this.save(audio) }];
    } catch (err) {
      console.warn(`${this.name} failed (${(err as Error).message}); using ${this.fallback.name}`);
      return this.fallback.pick(req);
    }
  }

  /** Writes the audio to a temp file, deleting old ones so they don't pile up. */
  private save(audio: Buffer): string {
    const file = path.join(this.dir, `reply-${++this.count}.wav`);
    fs.writeFileSync(file, audio);
    this.files.push(file);
    // Keep a few, since the previous reply may still be playing.
    while (this.files.length > 5) fs.rmSync(this.files.shift()!, { force: true });
    return file;
  }
}

/** Strips what a TTS model would read aloud badly: quotes, *actions*, emoji, extra length. */
export function cleanLine(raw: string): string {
  let line = raw
    .replace(/\*[^*]*\*/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/^\s*flowery\s*:\s*/i, '')
    .replace(/[\p{Extended_Pictographic}‍️]/gu, '')
    .replace(/["“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (line.length > 200) {
    const cut = line.slice(0, 200);
    const end = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
    line = end > 40 ? cut.slice(0, end + 1) : cut;
  }
  return line;
}

function writerMessage(req: PickRequest, recentLines: string[]): string {
  const said = `${req.speaker} said: "${req.transcript}"`;
  if (!recentLines.length) return said;
  return `${said}

Your last few lines (don't repeat them): ${recentLines.map((l) => `"${l}"`).join(', ')}`;
}

function buildWriterPrompt(clips: Clip[]): string {
  const examples = clips
    .filter((c) => c.used && !/variant|^\w+$/i.test(c.line))
    .map((c) => `- "${c.line}"`)
    .join('\n');
  return `You are Flowery, the smug, scheming flower from Deltarune Chapter 5, hanging out as a bot in a Discord voice chat. What you write is spoken aloud in your voice by a text-to-speech model.

Someone in the voice chat just said something to you. Their speech was transcribed automatically, so expect odd spellings ("Flowery" may show up as "flower e" or similar). Reply in character.

How to reply:
- One or two short sentences, at most about 20 words. It is spoken out loud, so short and punchy wins.
- Sound like Flowery: cheerful and smug on the surface, a little sinister underneath, fond of plant puns ("All according to plant", "Leaf it to me") and of calling people "guys" or "little guy".
- Answer what they actually said. Use their name only if it reads naturally.
- Write only the words to say: no quotation marks, no stage directions or *actions*, no emoji, no name prefix. Spell things the way they should be pronounced.

Lines Flowery says in the game, for his voice and style:
${examples}`;
}
