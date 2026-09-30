/**
 * 一次性验证: cover3d 的字符串注入在新掩码(高度包络)下是否仍然成立。
 * 用法: bun run scripts/verify-cover3d.ts
 * 跑完可删(它只做"锚点命中 + 产物内容"的静态校验, 不需要浏览器/GPU)。
 */
import { readFileSync, readdirSync } from 'node:fs';

import { patchCover3D } from '../src/lib/game/clouds-cover3d';

const base = 'node_modules/@takram/three-clouds/src/shaders';
// ⚠ 必须把**整个 shaders 目录**都拼进去: 关键的两个锚点
//   `uniform sampler3D shapeTexture;` / `uniform vec3 shapeOffset;` 在 `parameters.glsl`,
//   而调用点在 `clouds.frag` —— 只拼两三个文件会漏锚点, 补丁会**正确地拒绝注入**
//   (表现为 "着色器里没有 uniform sampler3D shapeTexture"), 那不是补丁的问题。
const files = readdirSync(base).filter((f) => f.endsWith('.glsl') || f.endsWith('.frag'));
const src = files.map((f) => readFileSync(`${base}/${f}`, 'utf8')).join('\n');

// 真实材质上的 fragmentShader = 库把 #include 就地展开后的字符串 ⇒ 这里用全量拼接近似
const mat = {
  fragmentShader: src,
  defines: {} as Record<string, unknown>,
  needsUpdate: false,
  uniforms: {} as Record<string, { value: number }>,
};

const res = patchCover3D(mat as never);
console.log('patch 结果:', JSON.stringify(res));
const s = mat.fragmentShader;
const hits: Array<[string, boolean]> = [
  ['包装函数已注入', s.includes('sampleWeatherCover3D')],
  ['调用点已改写', s.includes('sampleWeatherCover3D(uv, height, mipLevel, position)')],
  ['新掩码: 层厚', s.includes('maxHeight - minHeight')],
  ['新掩码: 包络', s.includes('cover3dEnv = 4.0 * cover3dHn * (1.0 - cover3dHn)')],
  ['新掩码: 判据', s.includes('smoothstep(uCover3DBias - 0.08, uCover3DBias + 0.08, cover3dEnv - 0.5)')],
  ['旧 3D 采样已移除', !s.includes('textureLod(shapeTexture, cover3dP')],
  ['旧列内比较已移除', !s.includes('cover3dN - cover3dNr')],
  ['uniform 声明仍完整(4 个)', ['uCover3DK', 'uCover3DScale', 'uCover3DBias', 'uCover3DRefY']
    .every((n) => new RegExp(`uniform float ${n};`).test(s))],
  ['uCover3DK 无重复定义风险', (s.match(/uniform float uCover3DK;/g) ?? []).length === 1],
];
for (const [k, ok] of hits) console.log(`  ${ok ? '✓' : '✗'} ${k}`);
const bad = hits.filter(([, ok]) => !ok);
console.log(bad.length === 0 ? '=> 全部通过' : `=> 失败 ${bad.length} 项`);
