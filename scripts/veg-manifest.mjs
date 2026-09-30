// 生成 public/textures/veg/manifest.json —— 磁盘上真实存在的植被贴片清单
//   为什么需要: veg 加载器原来靠 listDir(静态服务器不给目录索引) → 退化成"盲探"
//   8 编号 × 3 扩展 × 2 命名, 每次进关刷 70+ 条 404。清单只列真实存在的文件。
//   用法: node scripts/veg-manifest.mjs      (补了新素材后重跑一次即可)
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'public/textures/veg';
const SPECIES = ['conifer', 'decid', 'grass', 'bush'];
const EXTS = ['.png', '.jpg', '.jpeg', '.webp'];

function listFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const species = {};
const sheets = [];
const all = [];
for (const sp of SPECIES) {
  const out = [];
  // ① 子目录形式  <species>/<file>
  for (const e of listFiles(path.join(ROOT, sp))) {
    if (!e.isFile()) continue;
    if (!EXTS.includes(path.extname(e.name).toLowerCase())) continue;
    out.push(`${sp}/${e.name}`);
  }
  // ② 扁平形式  <species>_<n>.<ext>(import-asset.mjs --as 入库后的命名)
  for (const e of listFiles(ROOT)) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!EXTS.includes(ext)) continue;
    if (!e.name.startsWith(sp + '_')) continue;
    if (e.name.includes('_sheet')) { sheets.push(e.name); continue; }
    out.push(e.name);
  }
  if (out.length) species[sp] = out.sort();
  all.push(...out);
}
// 图集(不分物种的那几张, 例如 trees_sheet.png)也算 sheet
for (const e of listFiles(ROOT)) {
  if (e.isFile() && /_sheet\.(png|jpg|jpeg|webp)$/i.test(e.name) && !sheets.includes(e.name)) sheets.push(e.name);
}

const manifest = {
  generated: new Date().toISOString().slice(0, 16).replace('T', ' '),
  note: '由 scripts/veg-manifest.mjs 生成 —— 只列磁盘上真实存在的文件, 避免加载器盲探刷 404',
  species,
  sheets: sheets.sort(),
  count: all.length,
};
fs.writeFileSync(path.join(ROOT, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log('[veg-manifest] 写入', path.join(ROOT, 'manifest.json'));
for (const sp of SPECIES) console.log('   ' + sp.padEnd(8), (species[sp] || []).length, (species[sp] || []).join(' '));
console.log('   sheets  ', sheets.length, sheets.join(' '));
console.log('   合计    ', manifest.count);
