#!/usr/bin/env node
// scripts/blender-import.mjs
//
// Blender 导出产物 → 资产库。这是 blender/ 与游戏之间的**入口**。
//
// 分工(刻意分开, 免得两边格式跑偏):
//   · 压缩 + 落库 + 写 asset-library.json  → 仍然由 scripts/import-asset.mjs 做,
//     它是库格式的单一真相源, 本脚本不重复实现那套逻辑;
//   · 本脚本只负责 Blender 特有的那部分: 找到导出产物、校验它是真 GLB、
//     按预算报告体积、然后调 import-asset.mjs 登记。
//
// 用法:
//   node scripts/blender-import.mjs                      # 导入默认产物
//   node scripts/blender-import.mjs --budget             # 只看体积, 不落库
//   node scripts/blender-import.mjs --name hangar --kind scenery
//   node scripts/blender-import.mjs --inline             # 同时内联进单文件
//
// 默认源: blender/hangar/out/export/hangar.glb (由 blender/hangar/60_export.py 产出)

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flagVal = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (k) => argv.includes(k);

const SRC = flagVal('--src', join(ROOT, 'blender', 'hangar', 'out', 'export', 'hangar.glb'));
const NAME = flagVal('--name', 'hangar');
const KIND = flagVal('--kind', 'scenery');
const BUDGET_ONLY = has('--budget');
const INLINE = has('--inline');

/** glTF 二进制容器头: magic('glTF') + version + length。 */
function inspectGlb(path) {
  const buf = readFileSync(path);
  if (buf.byteLength < 12) return { ok: false, why: '文件小于 12 字节, 连 GLB 头都不完整' };
  if (buf.readUInt32LE(0) !== 0x46546c67) {
    return {
      ok: false,
      why: '不是 GLB(缺少 "glTF" 魔数)。检查 60_export.py 是否用了 export_format="GLB"',
    };
  }
  const version = buf.readUInt32LE(4);
  const declared = buf.readUInt32LE(8);
  if (declared !== buf.byteLength) {
    return { ok: false, why: `长度字段 ${declared} 与文件实际 ${buf.byteLength} 不符, 文件可能被截断` };
  }

  // 扫 JSON chunk 看有没有用到本仓库单文件构建里没有内联的扩展。
  const jsonLen = buf.readUInt32LE(12);
  const json = buf.subarray(20, 20 + jsonLen).toString('utf8');
  const usesDraco = json.includes('KHR_draco_mesh_compression');
  const usesKtx2 = json.includes('KHR_texture_basisu');
  const lights = json.includes('KHR_lights_punctual');
  const images = (json.match(/"images"\s*:\s*\[/g) || []).length;

  return { ok: true, version, usesDraco, usesKtx2, lights, images };
}

function main() {
  if (!existsSync(SRC)) {
    console.error(`[blender-import] 找不到 ${SRC}`);
    console.error('[blender-import] 先跑: blender --background --python blender/hangar/60_export.py');
    process.exit(1);
  }

  const bytes = statSync(SRC).size;
  const info = inspectGlb(SRC);
  console.log(`[blender-import] 源: ${SRC}`);
  console.log(`[blender-import] 体积: ${(bytes / 1048576).toFixed(2)} MB`);

  if (!info.ok) {
    console.error(`[blender-import] 校验失败: ${info.why}`);
    process.exit(1);
  }
  console.log(`[blender-import] glTF 版本 ${info.version}, 光源扩展 ${info.lights ? '有' : '无'}`);

  // 这两个警告不是洁癖: /draco/* 与 KTX2 转码器在单文件构建里没被内联,
  // 一旦用上, 双击单文件会加载失败 —— 而失败信息会是一条无关的 fetch 报错。
  if (info.usesDraco) {
    console.warn('[blender-import] ⚠ 用了 KHR_draco_mesh_compression。单文件构建未内联 /draco/*, ' +
      '双击单文件会失败。几何本来就只有几十 KB, 建议 60_export.py 里关掉 Draco。');
  }
  if (info.usesKtx2) {
    console.warn('[blender-import] ⚠ 用了 KHR_texture_basisu。确认 /basis/* 已内联, 否则同上。');
  }

  if (BUDGET_ONLY) {
    console.log('[blender-import] --budget: 只报告, 不落库');
    return;
  }

  const as = `/models/${NAME}/${basename(SRC)}`;
  const args = [
    join(ROOT, 'scripts', 'import-asset.mjs'),
    SRC,
    '--as', as,
    '--kind', KIND,
  ];
  if (INLINE) args.push('--inline');

  console.log(`[blender-import] → import-asset.mjs --as ${as} --kind ${KIND}${INLINE ? ' --inline' : ''}`);
  const res = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT });
  if (res.status !== 0) {
    console.error('[blender-import] import-asset.mjs 失败');
    process.exit(res.status ?? 1);
  }

  console.log('[blender-import] 完成。运行时这样取:');
  console.log(`  const { scene } = await loadGLB('${as}');`);
}

main();
