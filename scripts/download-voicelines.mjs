// Downloads Flowery's English voice clips from the Deltarune wiki and makes
// de-bitcrushed copies.
//
//   npm run download-voicelines            all English clips (used + unused in game)
//   npm run download-voicelines -- --used  only clips the game actually uses
//
// voicelines/original/  the wiki files as-is (bitcrushed, like in game)
// voicelines/clean/     de-bitcrushed, 48 kHz — what the bot plays by default
//
// About the bitcrush: the game's clips were downsampled to 22.05 kHz without
// filtering, then stored at 44.1 kHz. That mirrors the whole voice band
// (0–11 kHz) up into 11–22 kHz as harsh, metallic aliasing. The real voice
// below 11 kHz is intact, so a steep low-pass at ~10.5 kHz (done here by
// resampling down to 22.05 kHz with a long filter, then up to 48 kHz) removes
// the crush without touching the voice.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const ffmpeg = createRequire(import.meta.url)('ffmpeg-static');
const API = 'https://deltarune.wiki/api.php';
const PAGE = 'Flowery/Voice_Clips';
const HEADERS = { 'User-Agent': 'flowery-bot voice clip downloader' };
const originalDir = path.resolve('voicelines/original');
const cleanDir = path.resolve('voicelines/clean');
const usedOnly = process.argv.includes('--used');
const DECRUSH_FILTER = 'aresample=22050:filter_size=256:cutoff=0.95,aresample=48000:filter_size=256';

async function api(params) {
  const res = await fetch(`${API}?${new URLSearchParams({ format: 'json', ...params })}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Wiki API HTTP ${res.status}`);
  return res.json();
}

/** "Flowery voiceclip heh, it's my Jarona.wav" → "heh-its-my-jarona.wav" */
function localName(wikiName) {
  const base = wikiName.replace(/^Flowery voiceclip /i, '').replace(/\.wav$/i, '');
  return (
    base
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') + '.wav'
  );
}

// 1. Find clip files listed on the wiki page.
const wikitext = (await api({ action: 'parse', page: PAGE, prop: 'wikitext' })).parse.wikitext['*'];
const usedEnd = wikitext.indexOf('\n== ', wikitext.indexOf('== Used') + 5);
const names = [...new Set([...wikitext.matchAll(/\[\[File:([^|\]]+)/g)].map((m) => m[1].trim()))]
  .filter((f) => !/ JP\.\w+$/i.test(f)) // English only
  .filter((f) => !usedOnly || wikitext.indexOf(f) < usedEnd);

const urls = new Map();
for (let i = 0; i < names.length; i += 50) {
  const titles = names.slice(i, i + 50).map((f) => `File:${f}`).join('|');
  const pages = (await api({ action: 'query', prop: 'imageinfo', iiprop: 'url', titles })).query.pages;
  for (const p of Object.values(pages)) {
    if (p.imageinfo) urls.set(p.title.replace(/^File:/, ''), p.imageinfo[0].url);
  }
}

// 2. Download originals.
fs.mkdirSync(originalDir, { recursive: true });
fs.mkdirSync(cleanDir, { recursive: true });
let downloaded = 0;
for (const [name, url] of urls) {
  const dest = path.join(originalDir, localName(name));
  if (fs.existsSync(dest)) continue;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    console.warn(`  failed ${name}: HTTP ${res.status}`);
    continue;
  }
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  downloaded++;
  console.log(`  downloaded ${path.basename(dest)}`);
}

// 3. De-bitcrush every original that doesn't have a clean copy yet.
let cleaned = 0;
for (const file of fs.readdirSync(originalDir).filter((f) => f.endsWith('.wav'))) {
  const dest = path.join(cleanDir, file);
  if (fs.existsSync(dest)) continue;
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', path.join(originalDir, file), '-af', DECRUSH_FILTER, '-c:a', 'pcm_s16le', dest]);
  cleaned++;
}

// 4. Write voicelines/catalog.json: what each clip says and when the game uses it.
//    The LLM clip picker and the trigger config both refer to clips by `id`.
const catalog = buildCatalog(wikitext).filter((c) => fs.existsSync(path.join(originalDir, `${c.id}.wav`)));
fs.writeFileSync(path.resolve('voicelines/catalog.json'), JSON.stringify(catalog, null, 2) + '\n');

console.log(
  `Done: ${downloaded} downloaded, ${cleaned} de-bitcrushed, ${catalog.length} clips in catalog, ` +
    `${names.length - urls.size} listed on the wiki without a file.`,
);

/** Parses the "Used" and "Unused" wiki tables into [{ id, line, usage, used }]. */
function buildCatalog(text) {
  const usedStart = text.indexOf('== Used');
  const unusedStart = text.indexOf('== Unused');
  const end = text.indexOf('\n== ', unusedStart + 5);
  const sections = [
    { body: text.slice(usedStart, unusedStart), used: true },
    { body: text.slice(unusedStart, end), used: false },
  ];
  const clips = [];
  const seen = new Set();
  for (const { body, used } of sections) {
    for (const row of body.replace(/<!--[\s\S]*?-->/g, '').split(/\n\|-[^\n]*/)) {
      // Split the row into cells: a line starting with "|" opens a cell; other lines continue it.
      const cells = [];
      for (const l of row.split('\n')) {
        if (/^\|[}+]/.test(l) || l.startsWith('!') || l.startsWith('{|')) continue;
        if (l.startsWith('|')) cells.push(l.slice(1).replace(/^\s*(?:rowspan|colspan)="?\d+"?\s*\|/, '').trim());
        else if (cells.length) cells[cells.length - 1] += '\n' + l;
      }
      const isFile = (c) => c.includes('[[File:');
      const fileCell = cells.find((c) => isFile(c) && !/ JP\.\w+\|/i.test(c));
      const lineCell = cells.find((c) => !isFile(c));
      if (!fileCell || !lineCell) continue;
      const file = fileCell.match(/\[\[File:([^|\]]+)/)[1].trim();
      const id = localName(file).replace(/\.wav$/, '');
      if (seen.has(id)) continue;
      seen.add(id);
      const line = cleanWiki(lineCell).replace(/\s+/g, ' ').trim();
      const lastFileCell = cells.findLastIndex(isFile);
      const usage = cleanWiki(cells.slice(lastFileCell + 1).join('\n'))
        .split('\n')
        .map((l) => l.replace(/^[\s*]+/, '').trim())
        .filter(Boolean)
        .join('; ');
      clips.push({ id, line, usage, used });
    }
  }
  return clips;
}

function cleanWiki(s) {
  return s
    .replace(/<ref[\s\S]*?<\/ref>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\{\{[\s\S]*?\}\}/g, '')
    .replace(/\[\[File:[^\]]*\]\]/g, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/'''?/g, '')
    .replace(/[ \t]+/g, ' ');
}
