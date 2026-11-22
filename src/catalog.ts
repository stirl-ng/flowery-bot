import fs from 'node:fs';
import path from 'node:path';

/** One voice clip Flowery can play. */
export interface Clip {
  /** Stable id, e.g. "go-home". Used by triggers.json and the LLM picker. */
  id: string;
  /** What Flowery says in the clip. */
  line: string;
  /** When the game plays it — context that helps the LLM pick. */
  usage: string;
  /** false for clips that are in the game files but never played. */
  used: boolean;
  /** Absolute path of the audio file to play. */
  file: string;
}

interface CatalogEntry {
  id: string;
  line: string;
  usage?: string;
  used?: boolean;
}

const AUDIO_EXTENSIONS = ['.wav', '.mp3', '.ogg', '.opus', '.m4a', '.flac', '.webm'];

/**
 * Joins catalog.json (what each clip says) with the audio files present in
 * `audioDir`. Audio files with no catalog entry are still playable: their id
 * (file name) stands in for the line text, so you can drop in your own clips.
 */
export function loadCatalog(catalogFile: string, audioDir: string): Map<string, Clip> {
  const entries: CatalogEntry[] = fs.existsSync(catalogFile)
    ? JSON.parse(fs.readFileSync(catalogFile, 'utf8'))
    : [];
  const byId = new Map(entries.map((e) => [e.id, e]));

  const clips = new Map<string, Clip>();
  const files = fs.existsSync(audioDir) ? fs.readdirSync(audioDir) : [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!AUDIO_EXTENSIONS.includes(ext)) continue;
    const id = path.basename(f, path.extname(f));
    const entry = byId.get(id);
    clips.set(id, {
      id,
      line: entry?.line ?? id.replace(/[-_]+/g, ' '),
      usage: entry?.usage ?? '',
      used: entry?.used ?? true,
      file: path.join(audioDir, f),
    });
  }
  return clips;
}
