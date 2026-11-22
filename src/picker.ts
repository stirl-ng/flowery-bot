import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { Clip } from './catalog.ts';

export interface PickRequest {
  speaker: string;
  /** Everything the speaker said, including the wake word. */
  transcript: string;
  /** Ids of clips played recently in this channel, newest last, so the LLM can vary its replies. */
  recent?: string[];
}

/** Chooses which clip(s) Flowery replies with, in play order. */
export interface ClipPicker {
  readonly name: string;
  pick(req: PickRequest): Promise<Clip[]>;
}

export class RandomPicker implements ClipPicker {
  readonly name = 'random';
  private last: string | undefined;

  constructor(private readonly clips: Clip[]) {}

  async pick(): Promise<Clip[]> {
    // Unused clips are often fragments ("It", "Hah"), so leave them out of random picks.
    const usable = this.clips.filter((c) => c.used);
    const pool = usable.length > 1 ? usable.filter((c) => c.id !== this.last) : usable;
    if (pool.length === 0) return [];
    const clip = pool[Math.floor(Math.random() * pool.length)];
    this.last = clip.id;
    return [clip];
  }
}

/**
 * Asks Claude to choose 1..maxClips clips that best answer what was said.
 * Structured output restricts the answer to real clip ids, so the reply can
 * always be played as-is.
 */
export class ClaudePicker implements ClipPicker {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly system: string;
  private readonly schema;

  constructor(
    private readonly clips: Map<string, Clip>,
    private readonly opts: { model: string; effort: 'low' | 'medium' | 'high'; maxClips: number },
  ) {
    this.name = `claude (${opts.model})`;
    // Fail fast so a voice reply isn't held up for long; the caller falls back to random.
    this.client = new Anthropic({ timeout: 15_000, maxRetries: 1 });
    const ids = [...clips.keys()] as [string, ...string[]];
    this.schema = z.object({ clips: z.array(z.enum(ids)) });
    this.system = buildSystemPrompt([...clips.values()], opts.maxClips);
  }

  async pick(req: PickRequest): Promise<Clip[]> {
    // If a safety classifier declines (it shouldn't for this, but transcripts are
    // arbitrary speech), let the API retry on a fallback model instead of failing.
    // Haiku has no server-side fallback, so only send it where supported.
    const fallback = /^claude-(opus-5|sonnet-5-5|fable-5)/.test(this.opts.model)
      ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
      : {};
    const response = await this.client.beta.messages.parse({
      ...fallback,
      model: this.opts.model,
      max_tokens: 1024,
      output_config: { effort: this.opts.effort, format: betaZodOutputFormat(this.schema) },
      // The clip list is identical on every request, so cache it.
      system: [{ type: 'text', text: this.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage(req) }],
    });
    if (response.stop_reason === 'refusal' || !response.parsed_output) return [];
    return response.parsed_output.clips
      .slice(0, this.opts.maxClips)
      .map((id) => this.clips.get(id))
      .filter((c): c is Clip => !!c);
  }
}

/**
 * Asks Google Gemini to choose clips. Gemini's API has a free tier, so this works
 * without paid credits. JSON-schema output restricts the answer to real clip ids.
 */
export class GeminiPicker implements ClipPicker {
  readonly name: string;
  private readonly client: GoogleGenAI;
  private readonly system: string;
  private readonly schema: object;

  constructor(
    private readonly clips: Map<string, Clip>,
    private readonly opts: { apiKey: string; model: string; maxClips: number },
  ) {
    this.name = `gemini (${opts.model})`;
    this.client = new GoogleGenAI({ apiKey: opts.apiKey, httpOptions: { timeout: 15_000 } });
    this.system = buildSystemPrompt([...clips.values()], opts.maxClips);
    this.schema = {
      type: 'object',
      properties: { clips: { type: 'array', items: { type: 'string', enum: [...clips.keys()] } } },
      required: ['clips'],
    };
  }

  async pick(req: PickRequest): Promise<Clip[]> {
    const response = await this.client.models.generateContent({
      model: this.opts.model,
      contents: userMessage(req),
      config: {
        systemInstruction: this.system,
        responseMimeType: 'application/json',
        responseJsonSchema: this.schema,
      },
    });
    if (!response.text) return []; // blocked by a safety filter, or empty
    const ids: unknown = JSON.parse(response.text).clips;
    if (!Array.isArray(ids)) return [];
    return ids
      .slice(0, this.opts.maxClips)
      .map((id) => this.clips.get(String(id)))
      .filter((c): c is Clip => !!c);
  }
}

/** Builds the picker named by CLIP_PICKER, or falls back to random (with a warning) if its key is missing. */
export function createPicker(
  cfg: {
    clipPicker: string;
    claudeModel: string;
    claudeEffort: 'low' | 'medium' | 'high';
    geminiModel: string;
    geminiApiKey: string;
    maxClips: number;
  },
  catalog: Map<string, Clip>,
  random: ClipPicker,
): ClipPicker {
  if (catalog.size === 0 || cfg.clipPicker === 'random') return random;
  if (cfg.clipPicker === 'gemini') {
    if (cfg.geminiApiKey) return new GeminiPicker(catalog, { apiKey: cfg.geminiApiKey, model: cfg.geminiModel, maxClips: cfg.maxClips });
    console.warn('CLIP_PICKER=gemini but GEMINI_API_KEY is not set — "flowery ___" will play random clips.');
    return random;
  }
  if (cfg.clipPicker === 'claude') {
    if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
      return new ClaudePicker(catalog, { model: cfg.claudeModel, effort: cfg.claudeEffort, maxClips: cfg.maxClips });
    }
    console.warn('CLIP_PICKER=claude but ANTHROPIC_API_KEY is not set — "flowery ___" will play random clips.');
    return random;
  }
  console.warn(`Unknown CLIP_PICKER "${cfg.clipPicker}" (use gemini, claude or random) — using random.`);
  return random;
}

function userMessage(req: PickRequest): string {
  const said = `${req.speaker} said: "${req.transcript}"`;
  if (!req.recent?.length) return said;
  return `${said}

You recently played (oldest first): ${req.recent.join(', ')}. Avoid repeating these unless one is clearly the best reply.`;
}

function buildSystemPrompt(clips: Clip[], maxClips: number): string {
  const list = clips
    .map((c) => `- ${c.id}: "${c.line}"${c.used ? '' : ' [unused in game]'}${c.usage ? ` (in game: ${c.usage})` : ''}`)
    .join('\n');
  return `You are Flowery, the smug, scheming flower from Deltarune Chapter 5, hanging out as a bot in a Discord voice chat. You can only speak by playing your recorded voice clips.

Someone in the voice chat just said something to you (their speech was transcribed automatically, so expect odd spellings — "Flowery" may show up as "flower e" or similar). Reply by choosing clips from the list below, in the order they should play.

How to choose:
- Pick the clip(s) whose words best answer or react to what they said. Being funny and in character matters more than being literal.
- One clip is usually best. Chain up to ${maxClips} only when together they make a better reply (e.g. "hey-guys" then "hey-guys-i-think-i-found-a-glue").
- The "in game" notes tell you the situation each line was originally used in; use them to judge tone.
- Clips marked [unused in game] are often fragments; only use them when they fit perfectly.
- If they just said your name or greeted you, greet them back.
- Vary your replies: don't keep answering with the same clip.

Clips (id: "what Flowery says"):
${list}`;
}
