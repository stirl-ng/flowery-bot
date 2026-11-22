import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import type { Client, VoiceBasedChannel } from 'discord.js';
import prism from 'prism-media';
import {
  DISCORD_CHANNELS,
  DISCORD_FRAME_SIZE,
  DISCORD_SAMPLE_RATE,
  discordPcmSeconds,
  discordPcmToStt,
} from './audio.ts';
import type { Clip } from './catalog.ts';
import type { Config } from './config.ts';
import type { Responder } from './responder.ts';
import type { Transcriber } from './stt.ts';

interface Deps {
  client: Client;
  config: Config;
  transcriber: Transcriber;
  responder: Responder;
}

/** One bot presence in one voice channel: listens to everyone, replies when woken. */
export class VoiceSession {
  readonly connection: VoiceConnection;
  private readonly player: AudioPlayer;
  /** When the last reply finished playing. */
  private lastResponseAt = 0;
  /** Ids of recently played clips, newest last, so the LLM can avoid repeating itself. */
  private recent: string[] = [];
  /** True from the moment a reply is being chosen until its last clip finishes. */
  private responding = false;
  private queue: Clip[] = [];
  private destroyed = false;

  constructor(
    readonly channel: VoiceBasedChannel,
    private readonly deps: Deps,
    private readonly onDestroy: () => void,
  ) {
    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, // we need to hear people
      selfMute: false,
    });

    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    this.player.on('error', (err) => console.error(`[${this.tag}] playback error:`, err.message));
    // Multi-clip replies: start the next clip when the previous one ends.
    this.player.on(AudioPlayerStatus.Idle, () => this.playNext());
    this.connection.subscribe(this.player);

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Moved to another channel / transient blip: Discord reconnects on its own.
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.destroy(); // kicked or channel deleted
      }
    });
    this.connection.on(VoiceConnectionStatus.Destroyed, () => this.destroy());

    this.connection.receiver.speaking.on('start', (userId) => this.listenTo(userId));
  }

  private get tag() {
    return `${this.channel.guild.name} / ${this.channel.name}`;
  }

  async ready(): Promise<void> {
    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
  }

  /** Captures one utterance from a user (until they go quiet) and checks it for wake words. */
  private listenTo(userId: string) {
    const { receiver } = this.connection;
    if (receiver.subscriptions.has(userId)) return; // already capturing this utterance
    if (this.deps.client.users.cache.get(userId)?.bot) return;

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: this.deps.config.silenceMs },
    });
    const decoder = new prism.opus.Decoder({
      rate: DISCORD_SAMPLE_RATE,
      channels: DISCORD_CHANNELS,
      frameSize: DISCORD_FRAME_SIZE,
    });

    const maxBytes = this.deps.config.maxUtteranceSeconds * DISCORD_SAMPLE_RATE * DISCORD_CHANNELS * 2;
    let chunks: Buffer[] = [];
    let bytes = 0;

    decoder.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      bytes += chunk.length;
      // Keep only the most recent audio if someone talks for a long time.
      while (bytes > maxBytes && chunks.length > 1) {
        bytes -= chunks.shift()!.length;
      }
    });
    decoder.on('error', (err) => console.warn(`[${this.tag}] opus decode error:`, err.message));
    decoder.once('end', () => {
      const pcm = Buffer.concat(chunks, bytes);
      chunks = [];
      if (discordPcmSeconds(pcm.length) < this.deps.config.minUtteranceSeconds) return;
      this.handleUtterance(userId, pcm).catch((err) =>
        console.error(`[${this.tag}] failed to handle utterance:`, err),
      );
    });

    opusStream.pipe(decoder);
  }

  private async handleUtterance(userId: string, pcm: Buffer) {
    if (this.destroyed) return;
    const { config, transcriber, responder, client } = this.deps;

    const started = Date.now();
    const transcript = await transcriber.transcribe(discordPcmToStt(pcm));
    if (!transcript) return;

    const member = this.channel.guild.members.cache.get(userId);
    const userName = member?.displayName ?? client.users.cache.get(userId)?.username ?? userId;
    if (config.logTranscripts) {
      console.log(
        `[${this.tag}] ${userName} (${discordPcmSeconds(pcm.length).toFixed(1)}s, stt ${Date.now() - started}ms): ${transcript}`,
      );
    }

    // One reply at a time, and a short pause after each.
    if (this.responding) {
      if (config.logTranscripts) console.log(`[${this.tag}]   skipped: still replying`);
      return;
    }
    const cooldownLeft = this.lastResponseAt + config.cooldownMs - Date.now();
    if (cooldownLeft > 0) {
      if (config.logTranscripts) console.log(`[${this.tag}]   skipped: cooldown (${(cooldownLeft / 1000).toFixed(1)}s left)`);
      return;
    }
    this.responding = true;
    try {
      const pickStarted = Date.now();
      const reply = await responder.respond(userName, transcript, this.recent);
      if (!reply || reply.clips.length === 0 || this.destroyed) {
        if (reply && reply.clips.length === 0) {
          console.warn(`[${this.tag}] no voice lines available — run \`npm run download-voicelines\``);
        }
        this.responding = false;
        return;
      }
      console.log(
        `[${this.tag}] ${reply.via} ("${reply.heard}", ${Date.now() - pickStarted}ms) → ` +
          reply.clips.map((c) => `${c.id} "${c.line}"`).join(' + '),
      );
      this.recent = [...this.recent, ...reply.clips.map((c) => c.id)].slice(-8);
      this.queue = [...reply.clips];
      this.playNext();
    } catch (err) {
      this.responding = false;
      throw err;
    }
  }

  private playNext() {
    if (this.destroyed) return;
    const next = this.queue.shift();
    if (!next) {
      if (this.responding) this.lastResponseAt = Date.now(); // cooldown starts when the reply ends
      this.responding = false;
      return;
    }
    this.player.play(createAudioResource(next.file));
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.queue = [];
    this.player.stop(true);
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    }
    this.onDestroy();
  }
}
