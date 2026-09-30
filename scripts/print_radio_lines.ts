// Print the full radio line list (per-line voice plan) to stdout.
// Redirect to a file to refresh download/radio_lines_longlist.txt.
import { getRadioVoicePlan } from '../src/lib/game/radio';

const lines = getRadioVoicePlan();
let curEvent = '';
for (const l of lines) {
  if (l.event !== curEvent) {
    curEvent = l.event;
    console.log(`\n## ${curEvent}`);
  }
  console.log(`  [${l.id}] ${l.speaker} (${l.role}/${l.category}): ${l.text}`);
}
console.log(`\nTotal: ${lines.length} lines`);
