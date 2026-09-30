// Export the full per-line voice plan from src/lib/game/radio.ts to
// download/tts/voice-plan.json — the worklist that drives the IndexTTS2.5
// batch dubbing. Also prints a summary so we can sanity-check the pool sizes.
//
// Run:  bun scripts/export-radio-voices.ts
import { getRadioVoicePlan } from '../src/lib/game/radio';
import * as fs from 'fs';
import * as path from 'path';

// Run from the repo root (bun/node or via esbuild bundle) — root == cwd.
const repoRoot = process.cwd();
const outDir = path.join(repoRoot, 'download', 'tts');
const outFile = path.join(outDir, 'voice-plan.json');

const plan = getRadioVoicePlan();

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(plan, null, 2), 'utf-8');

// Summary
const byRole = new Map<string, number>();
const byCat = new Map<string, number>();
const byEvent = new Map<string, number>();
for (const l of plan) {
  byRole.set(l.role, (byRole.get(l.role) ?? 0) + 1);
  byCat.set(l.category, (byCat.get(l.category) ?? 0) + 1);
  byEvent.set(l.event, (byEvent.get(l.event) ?? 0) + 1);
}
console.log(`Total lines: ${plan.length}`);
console.log(`\nBy role (voice profile → #lines):`);
for (const [k, v] of byRole) console.log(`  ${k}: ${v}`);
console.log(`\nBy category: ${JSON.stringify(Object.fromEntries(byCat))}`);
console.log('\nEvents with < 5 variants (candidates to keep an eye on):');
for (const [k, v] of byEvent) if (v < 5) console.log(`  ${k}: ${v}`);
console.log(`\nWritten ${plan.length} entries → ${outFile}`);
