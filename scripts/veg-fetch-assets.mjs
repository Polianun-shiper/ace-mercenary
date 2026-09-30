#!/usr/bin/env node
// === scripts/veg-fetch-assets.mjs ==========================================
// 植被素材抓取器 (per user request: "怎么给 DeepSeek 搞贴图（也可以去网络找）")。
//
// 干什么:
//   把 CC0(公有领域)树木/植被贴片下载到 public/textures/veg/<物种>/, 之后游戏侧
//   `veg-textures.ts` 会自动:
//     · 认出 alpha 还是白底(白底自动走亮度白键)
//     · 一张图集自动**按 alpha 切株**(不用手写裁剪坐标)
//     · 每株宽高比自适应; 打包成一张图集, 实例化时靠 aUvOffset 挑株(仍 1 draw call)
//
// 用法:
//   node scripts/veg-fetch-assets.mjs                 # 下默认那几套 CC0
//   node scripts/veg-fetch-assets.mjs --only oga-trees     # 只下某一套
//   node scripts/veg-fetch-assets.mjs --list               # 只列可用源, 不下载
//   node scripts/veg-fetch-assets.mjs --species conifer    # 指定落到哪个物种目录
//
// 已实测可下的 CC0 源(2026-09 网络连通性):
//   oga-trees-bushes  https://opengameart.org/content/trees-bushes        (ansimuz, CC0, 像素风)
//   oga-trees-1       https://opengameart.org/content/trees-1             (Surt,    CC0)
//   oga-a-tree        https://opengameart.org/content/a-tree              (airockstar, CC0)
// 注意: 这几套是**像素风**, 放进写实向的游戏里风格会突; 管线本身与风格无关,
//       你可以把任何 CC0 素材(ambientCG / Poly Haven / itch.io 的 CC0 包)按同样命名丢进去。
//
// 命名约定(自动适配靠它):
//   public/textures/veg/conifer/任意名.png      ← 每株一文件(最简单)
//   public/textures/veg/conifer_sheet.png       ← 一张图集, 自动切株
//   (同理把 conifer 换成 decid / grass / bush)
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = join(ROOT, 'public', 'textures', 'veg');

const SOURCES = [
  {
    id: 'oga-trees-bushes',
    species: 'decid',
    url: 'https://opengameart.org/sites/default/files/trees_and_bushes_pack.zip',
    // zip 里挑这些成员(其余是 psd/license)
    zipPick: [/trees-and-bushes\.png$/i],
    license: 'CC0 — Luis Zuno (@ansimuz), https://creativecommons.org/publicdomain/zero/1.0/',
  },
  {
    id: 'oga-trees-1',
    species: 'conifer',
    url: 'https://opengameart.org/sites/default/files/dawntree.png',
    license: 'CC0 — Surt (opengameart.org/content/trees-1)',
  },
  {
    id: 'oga-a-tree',
    species: 'decid',
    url: 'https://opengameart.org/sites/default/files/treetest.png',
    license: 'CC0 — airockstar (opengameart.org/content/a-tree)',
  },
];

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const flag = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };

if (has('--list')) {
  for (const s of SOURCES) console.log(`${s.id.padEnd(18)} ${s.species.padEnd(8)} ${s.license}\n  ${s.url}`);
  process.exit(0);
}

const only = flag('--only', null);
const speciesOverride = flag('--species', null);
const picked = SOURCES.filter((s) => !only || s.id === only);
if (!picked.length) { console.error('没有匹配的源:', only); process.exit(1); }

const LICENSE = [];
for (const s of picked) {
  const species = speciesOverride || s.species;
  const dir = join(OUT_ROOT, species);
  mkdirSync(dir, { recursive: true });
  console.log(`\n[${s.id}] → public/textures/veg/${species}/`);
  try {
    const r = await fetch(s.url, { redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
    if (isZip && s.zipPick && s.zipPick.length) {
      // 只挑需要的成员解出来(不引入依赖: 手工扫中央目录太麻烦 → 交给系统 unzip)
      const tmpZip = join(dir, '_pack.zip');
      writeFileSync(tmpZip, buf);
      const { spawnSync } = await import('node:child_process');
      const res = spawnSync('unzip', ['-o', '-j', tmpZip, '-d', dir], { stdio: 'inherit' });
      if (res.status !== 0) throw new Error('unzip 失败(装个 unzip 或用 http 服务器直接把 zip 解开丢进来)');
      const { unlinkSync, readdirSync } = await import('node:fs');
      unlinkSync(tmpZip);
      // 去掉与物种无关的成员
      for (const f of readdirSync(dir)) {
        if (!/\.(png|jpg|jpeg|webp)$/i.test(f)) continue;
        if (!s.zipPick.some((re) => re.test(f))) {
          const { renameSync } = await import('node:fs');
          renameSync(join(dir, f), join(dir, '_ignored_' + f));
        }
      }
    } else {
      const name = s.url.split('/').pop().split('?')[0];
      writeFileSync(join(dir, name), buf);
    }
    console.log(`  ✓ ${s.license}`);
    LICENSE.push(`${s.id}\t${species}\t${s.license}\t${s.url}`);
  } catch (e) {
    console.warn('  ✗ 失败:', e.message);
  }
}

if (LICENSE.length) {
  const f = join(OUT_ROOT, 'LICENSES.txt');
  const prev = existsSync(f) ? '' : '来源\t物种\t授权\tURL\n';
  writeFileSync(f, prev + LICENSE.join('\n') + '\n', { flag: existsSync(f) ? 'a' : 'w' });
  console.log(`\n授权记录已写入 public/textures/veg/LICENSES.txt`);
}
console.log('\n下一步: 直接进关卡即可(游戏会自动适配)。想看报告: 关卡内控制台敲 `veg`。');
