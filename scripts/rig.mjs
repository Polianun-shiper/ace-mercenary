#!/usr/bin/env node
// scripts/rig.mjs
//
// 机体装配 rig 的**统一入口**(npm 脚本用)。存在的理由: 直接往 package.json 里写
// `"${BLENDER:-/c/...}" -b --python …` 这种 shell 语法, 在 Windows 的 cmd 下根本不成立
// (npm 在 Windows 默认走 cmd.exe) —— 与其给一个"看起来能用其实不能用"的入口,
// 不如收成一个小脚本: 找 Blender、转发参数、把退出码原样传出来。
//
// 用法:
//   node scripts/rig.mjs build   [--model f16c]     # 建可手拖的 rig 场景
//   node scripts/rig.mjs preview [--model f16c]     # 三视图接片
//   node scripts/rig.mjs export  [--model f16c]     # 写 public/config/aircraft-rig.json
//   node scripts/rig.mjs roundtrip [--model f16c]   # 门① 往返零漂移(只校验不写)
//
// Blender 路径: 取 $BLENDER; 否则试 Steam 默认安装位置与 PATH。

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HERE = join(ROOT, 'blender', 'aircraft');

const SCRIPTS = {
  build: '10_build.py',
  preview: '20_preview.py',
  export: '30_export.py',
  roundtrip: '30_export.py',
};

function findBlender() {
  const cands = [
    process.env.BLENDER,
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Blender\\blender.exe',
    'C:\\Program Files\\Steam\\steamapps\\common\\Blender\\blender.exe',
    '/c/Program Files (x86)/Steam/steamapps/common/Blender/blender.exe',
    'blender',
  ].filter(Boolean);
  for (const c of cands) {
    if (c === 'blender') return c;                  // 交给 PATH
    if (existsSync(c)) return c;
  }
  return null;
}

const argv = process.argv.slice(2);
const cmd = argv[0];
if (!cmd || !SCRIPTS[cmd]) {
  console.log('用法: node scripts/rig.mjs <build|preview|export|roundtrip> [--model f16c] [--no-obj]');
  process.exit(2);
}

const model = (() => {
  const i = argv.indexOf('--model');
  return i >= 0 ? argv[i + 1] : 'f16c';
})();

const blender = findBlender();
if (!blender) {
  console.error('找不到 Blender。设一个环境变量再跑, 例如:');
  console.error('  BLENDER="C:\\Program Files (x86)\\Steam\\steamapps\\common\\Blender\\blender.exe" '
    + `node scripts/rig.mjs ${cmd} --model ${model}`);
  process.exit(1);
}

// 透传 --model / --no-obj / --dry-run / --blend 等, 并补上 roundtrip 的开关
const passthrough = [];
for (let i = 1; i < argv.length; i++) passthrough.push(argv[i]);
if (cmd === 'roundtrip' && !passthrough.includes('--roundtrip')) passthrough.push('--roundtrip');
if (cmd === 'export' && !passthrough.includes('--model')) passthrough.push('--model', model);
if (cmd === 'build' && !passthrough.includes('--model')) passthrough.push('--model', model);
if (cmd === 'preview' && !passthrough.includes('--model')) passthrough.push('--model', model);
if (cmd === 'roundtrip' && !passthrough.includes('--model')) passthrough.push('--model', model);

const args = ['-b', '--factory-startup', '--python', join(HERE, SCRIPTS[cmd]), '--', ...passthrough];
console.log(`[rig] ${blender} ${args.join(' ')}\n`);
const r = spawnSync(blender, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
