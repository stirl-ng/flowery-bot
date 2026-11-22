// Downloads the offline speech-recognition model (~100 MB) into ./models.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MODEL = 'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8';
const URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL}.tar.bz2`;
const modelsDir = path.resolve('models');
const target = path.join(modelsDir, MODEL);

if (fs.existsSync(path.join(target, 'tokens.txt'))) {
  console.log(`Model already present at ${target}`);
  process.exit(0);
}

fs.mkdirSync(modelsDir, { recursive: true });
const archive = path.join(modelsDir, `${MODEL}.tar.bz2`);
console.log(`Downloading ${URL}`);
const res = await fetch(URL);
if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(archive));

console.log('Extracting…');
// `tar` ships with Windows 10+, macOS and Linux.
execFileSync('tar', ['-xjf', archive, '-C', modelsDir], { stdio: 'inherit' });
fs.rmSync(archive);
console.log(`Model ready at ${target}`);
