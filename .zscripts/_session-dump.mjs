// Dump a readable transcript from a decoded DSH session jsonl.
// Usage: node _session-dump.mjs <in.jsonl> <out.txt> [maxCharsPerMsg]
import fs from 'node:fs';

const [src, dst, maxArg] = process.argv.slice(2);
const max = Number(maxArg || 4000);
const lines = fs.readFileSync(src, 'utf8').split(/\r?\n/).filter(Boolean);
const out = [];
let n = 0;
for (const l of lines) {
  let o;
  try { o = JSON.parse(l); } catch { continue; }
  const d = o.data || {};
  if (o.type === 'agent/inbox/spliced' || o.type === 'agent/inbox') {
    for (const m of d.inserted || []) {
      const t = (m.content || []).map((c) => c.text || '').join('\n');
      if (t.trim()) out.push(`\n##### [${++n}] USER (spliced)\n${t}`);
    }
    continue;
  }
  const m = d.message;
  if (!m) continue;
  const role = m.role;
  if (role !== 'user' && role !== 'assistant') continue;
  const parts = [];
  for (const c of m.content || []) {
    if (typeof c === 'string') parts.push(c);
    else if (c.type === 'text' && c.text) parts.push(c.text);
    else if (c.type === 'tool_use') parts.push(`[tool_use ${c.name}] ${JSON.stringify(c.input).slice(0, 400)}`);
    else if (c.type === 'tool_result') parts.push(`[tool_result]`);
  }
  const t = parts.join('\n');
  if (!t.trim()) continue;
  out.push(`\n##### [${++n}] ${role.toUpperCase()}\n${t.length > max ? t.slice(0, max) + `\n...[truncated ${t.length - max} chars]` : t}`);
}
fs.writeFileSync(dst, out.join('\n'));
console.log(JSON.stringify({ messages: n, outBytes: fs.statSync(dst).size }));
