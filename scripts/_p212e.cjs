// 高度雾 v2 标定 + 默认开启:
//   实测目标(用户: "抹平远处地平线和天际线"):
//     · 40km 外的地形要几乎融进天空  → od ≥ 3
//     · 8~10km 处明显被大气吃掉但还看得见 → od ≈ 0.5~0.9
//     · 2km 内基本没有(别糊自己/僚机) → od ≤ 0.15
//     · 从 1200m 高度平视地平线也要有同样效果 ⇒ 尺度高度 H 不能太小(400m 时高空几乎没雾)
//   取 H = 1500m(1200m 处仍有 exp(-0.8)=0.45 的密度), density = 1.2e-4 /m:
//     地面水平 40km: 1.2e-4*40000 = 4.8 → alpha 0.99
//     1200m 看地平线(视线 -0.02, 落点 400m): 1.2e-4*1500/0.02*|e^-0.27 - e^-0.8| ≈ 2.83 → alpha 0.94
//     5km 处: ≈ 0.35 → alpha 0.30      垂直俯视: ≈ 0.056 → alpha 0.05
//   默认 **开启**(它是"远处地平线的处理", 不是可选的雾效); 关掉: 控制台 hfog 0 / 编辑器 toggle。
const fs = require('fs');
const p = 'src/lib/game/engine.ts';
let s = fs.readFileSync(p, 'utf8');
function once(a, l) { const n = s.split(a).length - 1; if (n !== 1) { console.error('miss', l, n); process.exit(1); } }

const f = [
  '  private _hfParams: HeightFogParamsV2 = {',
  '    hazeColor: new THREE.Color(0.72, 0.78, 0.86),',
  '    density: 4.0e-5,',
  '    baseHeight: 0,',
  '    scaleHeight: 400,',
  '    startDistance: 900,',
  '    maxOpacity: 0.9,',
  '    skyLift: 0.35,',
  '    skyBand: 0.05,',
  '    enabled: false,',
  '  };',
].join('\n');
once(f, 'params default');
s = s.replace(f, [
  '  // 标定依据见 height-fog.ts 顶部注释: H=1500m / density=1.2e-4 ⇒',
  '  // 40km 地平线 alpha≈0.99(融进天空), 8km≈0.7(还看得见), 2km 内≈0.1(不糊近处)。',
  '  private _hfParams: HeightFogParamsV2 = {',
  '    hazeColor: new THREE.Color(0.72, 0.78, 0.86),',
  '    density: 1.2e-4,',
  '    baseHeight: 0,',
  '    scaleHeight: 1500,',
  '    startDistance: 900,',
  '    maxOpacity: 0.92,',
  '    skyLift: 0.30,',
  '    skyBand: 0.05,',
  '    // 默认开: 这是"远处地平线/天际线"的处理(用户原话), 不是可选雾效。',
  '    // 关掉: 控制台 `hfog 0`, 或编辑器里把「启用高度雾」关掉。',
  '    enabled: true,',
  '  };',
].join('\n'));

// 默认 scaleHeight 若 tune 给了 falloff(编辑器默认 400) 会盖掉 1500 —— 那太"贴地"了。
// 把 tune 映射改成"falloff 只作为下限参考": 至少 600m, 否则高空没雾。
const m = '    if (hf.falloff !== undefined) this._hfParams.scaleHeight = Math.max(20, hf.falloff);';
once(m, 'falloff map');
s = s.replace(m, '    // 编辑器的 falloff 是"向上衰减范围"; 小于 600m 时高空几乎没雾, 所以取 max(600, falloff):\n'
  + '    if (hf.falloff !== undefined) this._hfParams.scaleHeight = Math.max(600, hf.falloff);');

fs.writeFileSync(p, s);
console.log('height fog defaults ok');

// 控制台快捷组
const c = 'src/components/game/DebugConsole.tsx';
let d = fs.readFileSync(c, 'utf8');
const anchor = "    label: 'HEIGHT FOG (体积雾)',\n    cmds: ['hfog 0', 'hfog 0.2', 'hfog 0.5', 'hfog 0.8'],";
once(d, 'hfog quick');
d = d.replace(anchor, [
  "    // v2: 屏幕空间解析积分, 目标是**抹平远处地平线与天际线**(把远地形融进天空色)。",
  "    // hfog 0 = 关; 0.3 轻雾(远山还清楚); 0.6 中; 0.9 重(地平线几乎完全融进天空)。",
  "    label: 'HEIGHT FOG (高度雾 v2 · 抹平地平线)',",
  "    cmds: ['hfog 0', 'hfog 0.3', 'hfog 0.6', 'hfog 0.9'],",
].join('\n'));
fs.writeFileSync(c, d);
console.log('console group ok');
