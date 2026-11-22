import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import { loadCatalog } from './catalog.ts';
import { config } from './config.ts';
import { createPicker, RandomPicker } from './picker.ts';
import { Responder } from './responder.ts';
import { VoiceSession } from './session.ts';
import { Transcriber } from './stt.ts';
import { loadTriggers } from './triggers.ts';

if (!config.token) {
  console.error('DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Flowery joins your voice channel and listens for his name'),
  new SlashCommandBuilder().setName('leave').setDescription('Flowery leaves the voice channel'),
].map((c) => c.toJSON());

console.log('Loading speech model…');
const transcriber = await Transcriber.load(config.modelDir);
const catalog = loadCatalog(config.catalogFile, config.voicelinesDir);
const triggers = loadTriggers(config.triggersFile, catalog);
const randomPicker = new RandomPicker([...catalog.values()]);
const picker = createPicker(config, catalog, randomPicker);
const responder = new Responder({
  catalog,
  triggers,
  wakeWords: config.wakeWords,
  threshold: config.wakeWordThreshold,
  maxClips: config.maxClips,
  picker,
  fallback: randomPicker,
});
console.log(`Speech model ready. ${catalog.size} voice line(s) in ${config.voicelinesDir}`);
if (catalog.size === 0) console.warn('No voice lines found — run `npm run download-voicelines`.');
console.log(`Wake words: ${config.wakeWords.join(', ')} → ${picker.name} picks the reply`);
console.log(`Triggers: ${triggers.length} phrase(s) from ${config.triggersFile}`);
if (process.env.DEBUG_VOICE) console.log(generateDependencyReport());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
const sessions = new Map<string, VoiceSession>(); // guildId → session

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  try {
    if (config.guildId) {
      await c.application.commands.set(commands, config.guildId);
      console.log(`Registered slash commands in guild ${config.guildId}`);
    } else {
      await c.application.commands.set(commands);
      console.log('Registered global slash commands (may take a while to appear)');
    }
  } catch (err) {
    if ((err as { code?: number }).code === 50001 && config.guildId) {
      const servers = c.guilds.cache.map((g) => `${g.name} (${g.id})`).join(', ') || 'none';
      console.error(
        `Can't register slash commands in GUILD_ID ${config.guildId}: Missing Access.\n` +
          `  Either the bot isn't in that server, or it was invited without the "applications.commands" scope.\n` +
          `  Servers the bot is in: ${servers}\n` +
          `  Invite it: https://discord.com/oauth2/authorize?client_id=${c.application.id}&scope=bot+applications.commands&permissions=3146752`,
      );
    } else {
      console.error('Failed to register slash commands:', err);
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.inCachedGuild()) return;
  try {
    if (interaction.commandName === 'join') await join(interaction);
    else if (interaction.commandName === 'leave') await leave(interaction);
  } catch (err) {
    console.error(err);
    const content = 'Something went wrong 🥀';
    if (interaction.deferred || interaction.replied) await interaction.editReply(content);
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
});

async function join(interaction: ChatInputCommandInteraction<'cached'>) {
  const channel = interaction.member.voice.channel;
  if (!channel || channel.type === ChannelType.GuildStageVoice) {
    await interaction.reply({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply();

  sessions.get(interaction.guildId)?.destroy();
  const session = new VoiceSession(channel, { client, config, transcriber, responder }, () => {
    if (sessions.get(interaction.guildId) === session) sessions.delete(interaction.guildId);
  });
  sessions.set(interaction.guildId, session);

  try {
    await session.ready();
  } catch {
    session.destroy();
    await interaction.editReply("Couldn't connect to the voice channel. Check my permissions (Connect, Speak).");
    return;
  }
  await interaction.editReply(`🌸 Listening in **${channel.name}**. Say *${config.wakeWords[0]}*!`);
}

async function leave(interaction: ChatInputCommandInteraction<'cached'>) {
  const session = sessions.get(interaction.guildId);
  if (!session) {
    await interaction.reply({ content: "I'm not in a voice channel.", flags: MessageFlags.Ephemeral });
    return;
  }
  session.destroy();
  await interaction.reply('🌸 Bye!');
}

// If everyone else leaves the channel, leave too.
client.on(Events.VoiceStateUpdate, (oldState) => {
  const session = sessions.get(oldState.guild.id);
  if (!session || oldState.channelId !== session.channel.id) return;
  const humans = session.channel.members.filter((m) => !m.user.bot);
  if (humans.size === 0) session.destroy();
});

const shutdown = () => {
  for (const s of sessions.values()) s.destroy();
  client.destroy().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await client.login(config.token);
