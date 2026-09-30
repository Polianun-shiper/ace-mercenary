// 统计单文件构建里"内联资产"的体积构成(与 scripts/build-single-html.mjs 的 ASSETS 对齐)。
// 用途: 决定瘦身优先级。用法: node scripts/report-inline-assets.mjs
import fs from 'node:fs';
import path from 'node:path';
import { INLINE_AUDIO } from './audio-assets.mjs';

const ROOT = process.cwd();
const pub = (p) => path.join(ROOT, 'public', p);
const exists = (p) => fs.existsSync(pub(p));
const size = (p) => { try { return fs.statSync(pub(p)).size; } catch { return 0; } };
const list = (d, re) => { try { return fs.readdirSync(pub(d)).filter((f) => re.test(f)).map((f) => `/${d}/${f}`); } catch { return []; } };

let ktxSets = [];
let terrains = {};
try {
  const m = JSON.parse(fs.readFileSync(pub('textures/ktx2/manifest.json'), 'utf8'));
  ktxSets = m.sets ?? [];
  terrains = m.terrains ?? {};
} catch { /* ignore */ }
const CH = ['albedo', 'normal', 'metallic', 'roughness', 'ao', 'emissive'];

const groups = new Map();
const add = (g, p) => groups.set(g, (groups.get(g) ?? 0) + size(p.replace(/^\//, '')));

for (const p of ['/models/f16c/f16c.obj.gz', '/models/f16c/f16c.mtl', ...list('models/f16c', /\.(jpg|jpeg|png)$/i)]) add('F-16C 机体+贴图', p);
for (const p of ['/models/MiG-29 (9-12).obj.gz', '/models/MiG-29 (9-12).mtl', ...list('textures/mig29', /\.(jpg|jpeg|png)$/i)]) add('MiG-29 机体+贴图', p);
add('B-52 机体', fs.existsSync(pub('models/b52.obj.gz')) ? 'models/b52.obj.gz' : 'models/b52.obj');
add('天空盒 4K (内联)', '/textures/sky/evening.exr');
add('天空盒 2K (内联)', '/textures/sky/evening-2k.exr');
add('天空盒 第一关 (内联)', fs.existsSync(pub('textures/sky/evening-046b.exr.gz')) ? 'textures/sky/evening-046b.exr.gz' : 'textures/sky/evening-046b.exr');

const music = ['music_mgs_1', 'music_mgs_2', 'music_online_menu', 'music_vitoze'];
const isMusic = (f) => music.includes(path.basename(f, '.mp3'));
for (const m of music) add('音乐 4 首 mp3', `/audio/${m}.mp3`);
// ⚠ 只统计**真正内联**的音频(scripts/audio-assets.mjs 是单一真相源)。
// 不要把 public/audio 全目录算进来 —— 那里面还有不内联的旧素材(dawn/light/
// sfx_storm_ambient 等), 会把总量算高, 让人误判瘦身优先级。
for (const p of INLINE_AUDIO) {
  const base = path.basename(p);
  if (isMusic(base)) continue;
  add(/\.wav$/i.test(base) ? '音效 wav (用户导入)' : '音效/环境 mp3', p);
}
let radio = 0;
for (const f of fs.readdirSync(pub('audio/radio'))) if (/\.mp3$/i.test(f)) radio += fs.statSync(pub(`audio/radio/${f}`)).size;
groups.set('电台语音 200 句', radio);
groups.set('Basis 转码器', size('basis/basis_transcoder.js') + size('basis/basis_transcoder.wasm'));
let ktx = 0;
for (const id of ktxSets) for (const ch of CH) ktx += size(`textures/ktx2/${id}/${ch}.ktx2`);
groups.set('KTX2 单位贴图集', ktx);
let ktxT = 0;
for (const [id, chs] of Object.entries(terrains)) for (const ch of chs) ktxT += size(`textures/ktx2/${id}/${ch}.ktx2`);
groups.set('KTX2 地形图层', ktxT);
groups.set('地形 高度/色/法线/AO', size('custom-maps/custom/heights.f32bin.gz') + size('custom-maps/custom/color.jpg') + size('custom-maps/custom/normal.jpg') + size('custom-maps/custom/ao.jpg'));
groups.set('配置 json', size('config/terrain-tune.json') + size('config/fx-tune.json'));

const MB = (b) => b / 1048576;
let raw = 0;
console.log('=== 内联资产估算 (raw MB → base64 MB) ===');
for (const [k, v] of [...groups.entries()].sort((a, b) => b[1] - a[1])) {
  raw += v;
  console.log(MB(v).toFixed(2).padStart(8), '→', (MB(v) * 4 / 3).toFixed(2).padStart(8), ' ', k);
}
console.log('TOTAL raw', MB(raw).toFixed(1), '→ base64', (MB(raw) * 4 / 3).toFixed(1));

// 明细: 音乐与 wav 逐文件
console.log('\n=== 音乐/长音频逐文件 (MB) ===');
for (const m of music) console.log(MB(size(`audio/${m}.mp3`)).toFixed(2).padStart(8), `audio/${m}.mp3`);
console.log('\n=== wav 逐文件 (MB) ===');
for (const f of fs.readdirSync(pub('audio')).filter((f) => /\.wav$/i.test(f))) console.log(MB(size(`audio/${f}`)).toFixed(2).padStart(8), `audio/${f}`);
void exists;
