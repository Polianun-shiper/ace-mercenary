// §218 ① 修"有位置标识但没有树": UV 变化属性缺失导致整批采样同一个 texel
//   注入进材质的着色器代码是 `vMapUv = vMapUv * aUvScale + aUvOffset;`(四个物种材质全注入),
//   但属性只在"该物种有 >1 个素材精灵"时才挂到几何上 ⇒ 草/灌木(程序化图集, 无精灵表)读不到
//   这两个属性: WebGL 下未定义属性读出来是 (0,0) ⇒ aUvScale=(0,0) ⇒ vMapUv=(0,0) ⇒
//   **整批永远采样 texel(0,0)** —— 程序化图集那个角通常是透明的 ⇒ alphaTest 全裁掉 ⇒ 看不见。
//   修法: 注入过 UV 变化的材质**总是**带属性(没有精灵表就给恒等: offset 0 / scale 1)。
// ② 分布太稀: 遮罩对比度调高(成"片"而不是均匀撒粉), 并提高草量。
const fs = require('fs');
const p = 'src/lib/game/environment.ts';
let s = fs.readFileSync(p, 'utf8');
function once(a, l) { const n = s.split(a).length - 1; if (n !== 1) { console.error('anchor miss', l, n); process.exit(1); } }

// ---- ① UV 属性必须总是存在 ----
const a1 = [
  '    let geoUse = geo;',
  '    const sprites = SPRITES_OF.get(mat);',
  '    if (sprites && sprites.length > 1 && list.sprite) {',
  '      const { aUvOffset, aUvScale } = buildUvVarietyAttributes(',
  '        sprites, (i: number) => (list.sprite as number[])[i] % sprites.length, n);',
  '      geoUse = geo.clone();',
  '      geoUse.setAttribute(\'aUvOffset\', aUvOffset);',
  '      geoUse.setAttribute(\'aUvScale\', aUvScale);',
  '    }',
].join('\n');
once(a1, 'uv attach');
s = s.replace(a1, [
  '    let geoUse = geo;',
  '    const sprites = SPRITES_OF.get(mat);',
  '    if (UV_VARIETY_MATS.has(mat)) {',
  '      // (per fix: "有位置标识却没有树") 这些材质的着色器里已经注入了',
  '      // `vMapUv = vMapUv * aUvScale + aUvOffset;` —— 那么几何上**必须**有这两个属性,',
  '      // 否则未定义属性读成 (0,0) ⇒ aUvScale=(0,0) ⇒ vMapUv 恒为 (0,0) ⇒ 整批采样同一个',
  '      // texel(通常是图集左上角的透明像素) ⇒ alphaTest 全裁掉 ⇒ 屏幕上什么都没有。',
  '      // 没有精灵表(程序化图集/单株素材)时给恒等值: offset (0,0) / scale (1,1)。',
  '      const hasSprites = !!(sprites && sprites.length && list.sprite);',
  '      const { aUvOffset, aUvScale } = hasSprites',
  '        ? buildUvVarietyAttributes(sprites!, (i: number) => (list.sprite as number[])[i] % sprites!.length, n)',
  '        : buildUvVarietyAttributes([], () => 0, n);',
  '      geoUse = geo.clone();',
  '      geoUse.setAttribute(\'aUvOffset\', aUvOffset);',
  '      geoUse.setAttribute(\'aUvScale\', aUvScale);',
  '    }',
].join('\n'));

// UV_VARIETY_MATS 定义(放在 BILLBOARD_MATS 旁边)
const a2 = '  const BILLBOARD_MATS = new Set<THREE.Material>([grassMat, bushMat]);';
once(a2, 'billboard mats');
s = s.replace(a2, [
  a2,
  '  /** 注入了"每实例 UV 变化"的材质(它们**必须**带 aUvOffset/aUvScale, 见 addInst) */',
  '  const UV_VARIETY_MATS = new Set<THREE.Material>([grassMat, bushMat, coniferMat, decidMat, coniferSnowMat]);',
].join('\n'));

// ---- ② 密度: 遮罩对比度抬高(成片) ----
const a3 = '    const noiseF = vegClamp01((0.35 + 1.05 * n) * barren);';
once(a3, 'noiseF');
s = s.replace(a3, [
  '    // === 对比度抬高 (per user request: 分布太稀少) ==============================',
  '    // 均匀撒粉看起来"哪儿都有点、哪儿都不像植被"。这里把密度分布**向高值集中**:',
  '    // 幂次 → 中低值被压下去(成裸地), 高值保留(成林地) ⇒ 观感是"一片一片"而不是"一把沙"。',
  '    const noiseF = Math.pow(vegClamp01((0.35 + 1.05 * n) * barren), 1.7);',
].join('\n'));
const a4 = '          patchiness: 0.35,\n          seed: mTune?.veg?.seed ?? 99,';
once(a4, 'patch mountain');
s = s.replace(a4, '          patchiness: 0.5,\n          seed: mTune?.veg?.seed ?? 99,');

// ---- ② b 草量再提 ----
once('          grassCount: mTune?.veg?.grassCount ?? 40000,', 'grass m');
s = s.replace('          grassCount: mTune?.veg?.grassCount ?? 40000,', '          grassCount: mTune?.veg?.grassCount ?? 60000,');
once('            grassCount: mTune?.veg?.grassCount ?? 15000,', 'grass i');
s = s.replace('            grassCount: mTune?.veg?.grassCount ?? 15000,', '            grassCount: mTune?.veg?.grassCount ?? 40000,');
once('          grassCount: vg?.grassCount ?? 20000,', 'grass c');
s = s.replace('          grassCount: vg?.grassCount ?? 20000,', '          grassCount: vg?.grassCount ?? 30000,');

fs.writeFileSync(p, s);
console.log('§218 ok: UV 属性恒等 + 遮罩对比度 + 草量');
