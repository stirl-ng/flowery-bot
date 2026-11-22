# Flowery Bot 🌸

A Discord bot that sits in a voice channel, listens to what people say, and plays one of Flowery's voice lines (from *Deltarune* Chapter 5) when someone says a wake word ("flowery" by default).

Speech recognition runs **locally on CPU**, using [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) with NVIDIA's Parakeet 110M English model. It needs no API keys and doesn't send audio to any outside service. Each utterance takes about 50 ms to transcribe.

## How it works

```
Discord voice ─► per-user Opus stream ─► decode (48 kHz stereo)
   ─► wait for ~600 ms of silence ─► downmix/resample to 16 kHz mono
   ─► speech-to-text ─► choose reply ─► play clip(s) in order
```

- **Per-user capture.** Discord sends each speaker's audio separately. The bot collects one utterance per person, from when they start talking until they go quiet for `SILENCE_MS`.
- **Fuzzy matching** ([src/wakeword.ts](src/wakeword.ts)). The matcher compares letters only, ignores spaces, and accepts near-misses above `WAKE_WORD_THRESHOLD`. The default of 0.9 lets "flowery" through but not "flower" or "flowers". Made-up names need a looser threshold: the recognizer wrote "Flowerman" as "Flow Erman", for example.
- **Cooldown.** The bot replies to one thing at a time, and waits `COOLDOWN_MS` (1.5 s) after a reply finishes before the next. Anything said in between is logged as `skipped`.

## How Flowery picks what to say

[src/responder.ts](src/responder.ts) checks every utterance in this order:

| # | Heard | Reply | Speed |
|---|---|---|---|
| 1 | A phrase from [triggers.json](triggers.json), e.g. "San Francisco", "Flowery, go home" | That trigger's specific clip(s) | Instant |
| 2 | The wake word: "Flowery, ___" | An LLM (Gemini or Claude) reads the whole sentence and picks 1–3 fitting clips, played back to back | About 1–2 s |
| 3 | Neither | Nothing | |

If the LLM fails or times out, or there's no API key, step 2 plays a random clip instead.

### Triggers (phrase → specific clip)

Each trigger in [triggers.json](triggers.json) maps one or more phrases to one or more clips:

```json
{ "phrases": ["san frandisco", "san francisco"], "clips": ["here-i-come-san-frandisco"] }
{ "phrases": ["i found a glue"], "clips": ["hey-guys", "hey-guys-i-think-i-found-a-glue"] }
{ "phrases": ["flowery attack"], "clips": ["jarona-1", "jarona-2", "jarona-3", "jarona-4"], "pick": "random" }
```

- **`phrases`** fire when heard anywhere in a sentence. Include "flowery" in a phrase if it should only fire when someone addresses him.
- **`clips`** play in order. With `"pick": "random"`, one of them plays instead.
- **Several triggers in one sentence** all play, in the order they were said, up to `MAX_CLIPS` clips.
- **`threshold`** (optional) loosens or tightens matching for that one trigger. Use it for names the speech recognizer spells oddly, like "Jarona".
- **Clip ids** are the file names in `voicelines/clean/` without `.wav`. The full list, with what each clip says, is in `voicelines/catalog.json`.

The file is read at startup, so restart the bot after editing it. Run `npm run test-stt -- clip.wav` on a recording to check what a phrase triggers.

### An LLM picking clips ("Flowery, ___")

[src/picker.ts](src/picker.ts) gives the model the list of every clip: what Flowery says in it and when the game uses it, both taken from the wiki. The model then gets the speaker's name and their sentence, and answers with clip ids in play order. The answer is constrained to real clip ids, so it can always be played.

`CLIP_PICKER` picks the provider:

| `CLIP_PICKER` | Key | Cost |
|---|---|---|
| `gemini` (default) | `GEMINI_API_KEY`, free from [Google AI Studio](https://aistudio.google.com/apikey) | Free tier, rate-limited; Google may use free-tier prompts to improve its models |
| `claude` | `ANTHROPIC_API_KEY` | Paid API credits |
| `random` | none | Free, no LLM |

- Gemini's model is `GEMINI_MODEL` (default `gemini-flash-lite-latest`, fast and on the free tier).
- Claude's model is `CLAUDE_MODEL` (default `claude-opus-5-5`) at `CLAUDE_EFFORT=low`.
- `MAX_CLIPS` caps how many clips one reply can chain together.

Requests only happen after the wake word. The console logs every choice, for example:

```
[server / General] llm ("flowery", 1180ms) → hey-guys "Hey guys" + smile-again "Smile again"
```

## Setup

1. **Create the Discord app.** Go to the [Developer Portal](https://discord.com/developers/applications), click New Application, then open Bot and click Reset Token. Copy the token.
2. **Invite the bot.** Under OAuth2 → URL Generator, tick the scopes `bot` and `applications.commands`, and the bot permissions **Connect**, **Speak** and **View Channels**. Open the generated URL and add the bot to your server.
3. **Install:**
   ```powershell
   npm install
   ```
   ```powershell
   npm run download-model
   ```
   ```powershell
   npm run download-voicelines
   ```
4. **Configure:**
   ```powershell
   Copy-Item .env.example .env
   ```
   Then set `DISCORD_TOKEN` in `.env`. Also set `GUILD_ID` (right-click your server → Copy Server ID, with Developer Mode on) so the slash commands appear straight away.
5. **Run:**
   ```powershell
   npm start
   ```

You need Node 22.12 or later. FFmpeg is bundled through `ffmpeg-static`, so there's nothing else to install.

## Using it

- `/join`: the bot joins your current voice channel and starts listening.
- `/leave`: the bot leaves.
- The bot also leaves on its own once no humans are left in the channel.

With `LOG_TRANSCRIPTS=true`, every transcript is printed to the console. Use these logs to see how the recognizer hears your wake words, then tune `WAKE_WORDS` and `WAKE_WORD_THRESHOLD` to match.

## Voice lines

`npm run download-voicelines` fetches Flowery's 91 English clips from the [Deltarune wiki](https://deltarune.wiki/w/Flowery/Voice_Clips), covering lines both used and unused in the game. Add `-- --used` to fetch only the 80 the game uses. It writes two folders:

| Folder | Contents |
| --- | --- |
| `voicelines/original/` | The wiki files as they are: bitcrushed, the way they sound in the game |
| `voicelines/clean/` | De-bitcrushed copies. **The bot plays these by default.** |

To use the in-game crunchy versions instead, set `VOICELINES_DIR=voicelines/original`. You can also put your own `.mp3`, `.wav`, `.ogg`, `.opus`, `.m4a`, `.flac` or `.webm` files in either folder.

**How the bitcrush is removed.** The game's clips were downsampled to 22.05 kHz without filtering, then stored at 44.1 kHz. That copies the whole voice range (0–11 kHz) as a mirror image into 11–22 kHz, which is the metallic crunch you hear. The real voice below 11 kHz is untouched, so a steep low-pass filter at about 10.5 kHz removes the crunch and keeps the voice. FFmpeg does this by resampling to 22.05 kHz with a long filter and then back up to 48 kHz. The result sounds a little less bright than a full-range recording, because the game never had any real content above 11 kHz.

Both folders are gitignored. The clips are Toby Fox's copyrighted game audio, so keep them out of public repos and re-download them on each machine instead.

## New lines in Flowery's voice (F5-TTS)

Besides the game clips, Flowery can say new lines. With `REPLY_MODE=voice`, the `CLIP_PICKER` LLM (Gemini or Claude) writes a short reply in his style. [F5-TTS](https://github.com/SWivid/F5-TTS), running on your own GPU, then speaks it in a voice cloned from his clips. On an RTX 4090 a whole reply, writing and speaking, takes about 1.5 s.

```
"Flowery, ___" ─► LLM writes a line ─► tts/server.py (F5-TTS) ─► temp .wav ─► play
```

**Setup.** You need [uv](https://docs.astral.sh/uv/) and, for usable speed, an NVIDIA GPU. The first run downloads about 1.5 GB of model weights from Hugging Face.

```powershell
npm run setup-tts
```

Then set `REPLY_MODE=voice` in `.env` and keep the TTS server running next to the bot:

```powershell
npm run tts
```

**Making clips by hand.** You can also generate a specific line yourself, for example to put it in `voicelines/clean/` and give it a trigger:

```powershell
npm run say -- "Leaf it to me, guys!"
```

This writes `voicelines/generated/leaf-it-to-me-guys.wav`. Add `--crunch` to bitcrush it like the game, or `--out file.wav` to choose the path.

**How it works.**
- **Voice reference.** [tts/server.py](tts/server.py) trims the silence off a set of clear clips from `voicelines/clean/` and joins them (about 11 s) into `voicelines/reference-<set>.wav`, passing their exact transcript along with it. F5-TTS copies the reference's pacing and stress, and it sets each line's length from the reference's seconds per character, so leftover silence makes every line slow and slurred. `TTS_REFERENCE` picks the set:

  | `TTS_REFERENCE` | Clones from |
  |---|---|
  | `auto` (default) | `exuberant` for lines with "!", `mixed` for the rest |
  | `mixed` | Chatty and excited lines in one reference: "Hey guys, I think I found a glue", "Here I come, San Frandisco!", "Heh, it's my Jarona!" |
  | `exuberant` | Excited lines: "Here I come, San Frandisco!", "Don't you like serving humans?", "Leaf it to me!" |
  | `conversational` | Only everyday lines: "Sorry about that, little guy", "Your dad's my best friend" |
  | `smug` | "It's me, Flowery", "What a predictable creature" |

  To add a set, edit `REFERENCE_SETS` in that file and keep it under 12 s.
- **Fallback.** If the server is down or too slow (`TTS_TIMEOUT_MS`), or the LLM fails, the reply falls back to the `CLIP_PICKER` clip choice, and then to a random clip. Triggers don't change and always play game clips.
- **Bitcrush.** `TTS_CRUNCH=true` applies the game's 22.05 kHz bitcrush to generated lines so they match `voicelines/original`. It's on by default when the bot plays those originals.
- **Tuning.** `TTS_SPEED` sets the speaking rate. `TTS_NFE_STEPS` trades quality for speed: the default is 32, 64 is a little cleaner and about twice as slow, and 16 is twice as fast. `TTS_CFG` (default 2.0) sets how strictly it follows the text: around 2.5 gives crisper words with a flatter delivery.

**Rights.** The cloned voice comes from Toby Fox's copyrighted game audio and a real performer's voice, so keep it on your own server. `voicelines/reference.wav` and `voicelines/generated/` are gitignored, like the clips.

## Development

| Command | What it does |
| --- | --- |
| `npm run dev` | Run with auto-restart on file changes |
| `npm test` | Unit tests for wake-word matching, reply routing and the voice fallback |
| `npm run typecheck` | TypeScript check |
| `npm run download-voicelines` | Fetch clips from the wiki and generate the de-bitcrushed copies (skips files already present) |
| `npm run test-stt -- clip.wav` | Show what a recording transcribes to and which clips it would play, without Discord. Add `--llm` to use the `CLIP_PICKER` model (makes API calls) |
| `npm run setup-tts` | Install F5-TTS and CUDA PyTorch into `tts/.venv` (uses uv) |
| `npm run tts` | Run the F5-TTS server the bot uses with `REPLY_MODE=voice` |
| `npm run say -- "text"` | Speak one line in Flowery's voice into `voicelines/generated/` |

## Tuning and known limits

- **Response delay.** The bot replies only after the speaker stops talking (`SILENCE_MS`). Lowering it makes replies faster but can cut people off mid-sentence. If the bot needs to interrupt long monologues, the next step is a streaming recognizer.
- **False triggers.** If similar words set the bot off, raise `WAKE_WORD_THRESHOLD`. If it misses real wake words, lower it or add the misheard spellings from the logs to `WAKE_WORDS`.
- **Long utterances.** Anything longer than 15 s is trimmed to its last 15 s (`MAX_UTTERANCE_SECONDS`).
