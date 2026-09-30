// 修 worklog: 我把 §217 的**标题行**按 UTF-8 追加进了 GBK 文件(2 个乱码字符)。
// 做法: 按字节找到 "## 2026-09-18 (" 最后一次出现处截断, 再用 GBK 追加标题+正文。
const fs = require('fs');
const { execFileSync } = require('child_process');
const file = 'worklog.md';
const buf = fs.readFileSync(file);
const marker = Buffer.from('## 2026-09-18 (', 'latin1');
const at = buf.lastIndexOf(marker);
if (at < 0) { console.error('marker not found'); process.exit(1); }
const clean = buf.subarray(0, at);
console.log('truncate', buf.length, '->', clean.length);

const header = '\n\n## 2026-09-18 (§217) 树看不见=密度太低 + vegdbg debug 层 + 一处自我纠错\n\n';
const body = fs.readFileSync('.shots/wl217.md', 'utf8');
fs.writeFileSync('.shots/_t.txt', header + body);
const g = execFileSync('iconv', ['-f', 'UTF-8', '-t', 'GBK', '.shots/_t.txt']);
fs.writeFileSync(file, Buffer.concat([clean, g]));
console.log('worklog §217 re-appended (GBK)', g.length);
