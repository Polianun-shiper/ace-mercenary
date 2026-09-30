#!/usr/bin/env node
// scripts/hangar-shot.mjs
//
// 机库截图 / 探针的专用封装。
//
// 为什么需要它: ui-shot.mjs 的执行顺序是 **先 --wait 再 --js**, 所以点进机库之后
// 只留 500ms 给场景加载 —— 机库永远停在"正在加载模型"。实测这就是之前所有机库
// 截图全黑的原因, 不是 WebGL 的问题(那台无头 Edge 用的是真 GTX 1080 / D3D11)。
// 这个封装把"点击 + 等待 + 调相机 + 读状态"整段塞进一次 Runtime.evaluate
// (ui-shot 已带 awaitPromise), 并自动放宽 CDP 超时。
//
// 用法:
//   node scripts/hangar-shot.mjs <out.png> [选项]
//     --url <url>      默认 http://127.0.0.1:8898/index.html#desktop
//     --w/--h          分辨率, 默认 1280x800
//     --yaw/--pitch/--dist   设机位(不传则保持游戏默认)
//     --env <n>        覆盖机体材质的 envMapIntensity
//     --noibl          把 scene.environmentIntensity 设 0(诊断双重计光)
//     --load <ms>      点进机库后的等待, 默认 100000(机体 OBJ 很大, 需要这么久)
//
// 例:
//   node scripts/hangar-shot.mjs .shots/a.png --yaw 0.35 --dist 38
//   node scripts/hangar-shot.mjs .shots/b.png --env 0.8
//   node scripts/hangar-shot.mjs .shots/c.png --noibl

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flagVal = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (k) => argv.includes(k);

const out = argv.find((a) => !a.startsWith('--') && a.endsWith('.png')) || '.shots/hangar-shot.png';
const URL_ = flagVal('--url', 'http://127.0.0.1:8898/index.html#desktop');
const W = Number(flagVal('--w', 1280));
const H = Number(flagVal('--h', 800));
const YAW = flagVal('--yaw', null);
const PITCH = flagVal('--pitch', null);
const DIST = flagVal('--dist', null);
const ENV = flagVal('--env', null);
const NOIBL = has('--noibl');
const LOAD = Number(flagVal('--load', 100000));
// 机型列表里点一个型号(按文字包含匹配), 例如 --model MiG-29
const MODEL = flagVal('--model', null);
const MODEL_LOAD = Number(flagVal('--model-load', 45000));

const steps = [
  'h.autoRotate = false;',
  YAW !== null ? `h.targetYaw = ${YAW};` : '',
  PITCH !== null ? `h.targetPitch = ${PITCH};` : '',
  DIST !== null ? `h.targetDist = ${DIST};` : '',
  ENV !== null ? `retuneEnv(${ENV});` : '',
  NOIBL ? 'sc.environmentIntensity = 0;' : '',
].filter(Boolean).join('\n  ');

// 切机型要放在等待之后: 列表点一下会重新加载机体几何。
const modelStep = MODEL
  ? `const mt = [...document.querySelectorAll('*')].filter(
      (e) => !e.children.length && e.textContent.includes(${JSON.stringify(MODEL)}));
     if (mt.length) { mt[0].click(); await sleep(${MODEL_LOAD}); }
     else return JSON.stringify({ noModel: ${JSON.stringify(MODEL)} });`
  : '';

// 注意: 这段是在页面里跑的, 只能用浏览器 API。
const js = `(async () => { try {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const menu = [...document.querySelectorAll('*')].filter(
    (e) => !e.children.length && e.textContent.trim() === '机库');
  if (!menu.length) return JSON.stringify({ noMenu: true });
  menu[0].click();
  await sleep(${LOAD});
  const h = window.__hangar;
  if (!h) return JSON.stringify({ noHandle: true });
  const sc = h.sceneRef();

  // 机库网格在图层 1 => layers.mask === 2 (mask 1 是图层 0)
  const HANGAR = 2;
  const eachMat = (fn) => sc.traverse((o) => {
    if (!o.isMesh) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of ms) if (m && m.isMeshStandardMaterial) fn(m, o);
  });
  const retuneEnv = (v) => eachMat((m) => { m.envMapIntensity = v; m.needsUpdate = true; });

  ${modelStep}
  ${steps}
  await sleep(4000);

  const a = { mats: 0, map: 0, nrm: 0, rgh: 0, ao: 0, hiEnv: 0 };
  eachMat((m) => { a.mats++; if (m.map) a.map++; if (m.normalMap) a.nrm++;
                   if (m.roughnessMap) a.rgh++; if (m.aoMap) a.ao++;
                   if (m.envMapIntensity > 1) a.hiEnv++; });
  let hangarMats = 0;
  sc.traverse((o) => { if (o.isMesh && o.layers.mask === HANGAR) hangarMats++; });
  return JSON.stringify({ ok: true, all: a, hangarMeshes: hangarMats, envI: sc.environmentIntensity });
} catch (e) { return JSON.stringify({ err: String((e && e.message) || e).slice(0, 160) }); } })()`;

const args = [
  join(ROOT, 'scripts', 'ui-shot.mjs'), URL_, out,
  '--w', String(W), '--h', String(H), '--wait', '3000', '--js', js,
];
console.log('[hangar-shot]', out,
  YAW !== null ? `yaw=${YAW}` : '', PITCH !== null ? `pitch=${PITCH}` : '',
  DIST !== null ? `dist=${DIST}` : '', ENV !== null ? `env=${ENV}` : '',
  NOIBL ? 'noibl' : '');

const res = spawnSync(process.execPath, args, {
  stdio: 'inherit', cwd: ROOT,
  env: { ...process.env, UI_SHOT_CDP_TIMEOUT_MS: '200000' },
});
process.exit(res.status ?? 1);
