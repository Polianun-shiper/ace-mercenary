// Post-process raw IndexTTS2.5 dubs into the game's voice library.
// ===========================================================================
// Input : download/tts/raw/<role>/<lineId>.wav   (raw TTS output, per voice plan)
// Output: public/audio/radio/<lineId>.mp3        (trim + normalize + 48k mono mp3)
//         public/audio/radio/manifest.json       (id → durationSec + metadata)
//
// FFmpeg is resolved from (in order):
//   1. env FFMPEG_PATH
//   2. download/tts/ffmpeg-path.txt (a single line with the ffmpeg path)
//   3. the `ffmpeg-static` npm package
//   4. plain `ffmpeg` on PATH
//
// Run: node scripts/postprocess-radio-voices.mjs [--id mission_start-0]
//      (optional --id restricts processing to one lineId)
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = process.cwd();
const RAW_DIR = path.join(repoRoot, 'download', 'tts', 'raw');
const OUT_DIR = path.join(repoRoot, 'public', 'audio', 'radio');
const PLAN_FILE = path.join(repoRoot, 'download', 'tts', 'voice-plan.json');

const argId = (() => {
  const i = process.argv.indexOf('--id');
  return i >= 0 ? process.argv[i + 1] : null;
})();

// ---- FFmpeg path resolution ------------------------------------------------
function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  const pFile = path.join(repoRoot, 'download', 'tts', 'ffmpeg-path.txt');
  if (fs.existsSync(pFile)) {
    const p = fs.readFileSync(pFile, 'utf-8').trim();
    if (p && fs.existsSync(p)) return p;
  }
  try {
    const fp = require('ffmpeg-static');
    if (fp && fs.existsSync(fp)) return fp;
  } catch { /* not installed */ }
  return 'ffmpeg';
}
const FFMPEG = resolveFfmpeg();

function run(args) {
  const r = spawnSync(FFMPEG, args, { encoding: 'utf-8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const tail = (r.stderr || '').split('\n').slice(-12).join('\n');
    throw new Error(`ffmpeg failed (${r.status}):\n${tail}`);
  }
  // ffmpeg logs (incl. "Duration:") go to stderr.
  return (r.stdout || '') + (r.stderr || '');
}

/** Parse "Duration: HH:MM:SS.cc" from ffmpeg's own probe pass. */
function probeDuration(file) {
  const out = run(['-hide_banner', '-i', file, '-f', 'null', '-']);
  const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(out);
  if (!m) throw new Error(`duration probe failed for ${file}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// ---- Main -------------------------------------------------------------------
if (!fs.existsSync(PLAN_FILE)) {
  console.error('voice-plan.json missing — run: bun scripts/export-radio-voices.ts first');
  process.exit(1);
}
const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf-8'));
const meta = new Map(plan.map((e) => [e.id, e]));

fs.mkdirSync(OUT_DIR, { recursive: true });

const manifest = [];
let processed = 0;
let skipped = [];
for (const entry of plan) {
  if (argId && entry.id !== argId) continue;
  // Raw dubs are stored under the role folder: raw/<role>/<id>.wav
  const raw = path.join(RAW_DIR, entry.role, `${entry.id}.wav`);
  if (!fs.existsSync(raw)) { skipped.push(entry.id); continue; }
  const outMp3 = path.join(OUT_DIR, `${entry.id}.mp3`);
  const filter =
    'silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.15,' +
    'areverse,silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.15,areverse,' +
    'loudnorm=I=-18:TP=-1.5:LRA=11';
  run([
    '-y', '-i', raw,
    '-af', filter,
    '-ac', '1', '-ar', '22050',
    '-c:a', 'libmp3lame', '-b:a', '48k',
    outMp3,
  ]);
  const duration = Math.round(probeDuration(outMp3) * 1000) / 1000;
  manifest.push({
    id: entry.id,
    file: `/audio/radio/${entry.id}.mp3`,
    duration,
    event: entry.event,
    role: entry.role,
    speaker: entry.speaker,
    side: entry.side,
    category: entry.category,
    text: entry.text,
  });
  processed++;
  if (argId) console.log(`processed ${entry.id} (${duration}s)`);
}

fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
console.log(`\nProcessed ${processed} lines → public/audio/radio/ (manifest has ${manifest.length} entries)`);
if (skipped.length) console.log(`Missing raw dubs (skipped): ${skipped.length} — e.g. ${skipped.slice(0, 8).join(', ')}`);
