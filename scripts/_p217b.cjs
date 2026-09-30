// §217 重做(上一版锚点没对上, 整脚本原子回滚了 —— 这次按文件里的**原文**改, 三条路径全覆盖):
//   ① mountain: spread 18900→7000, count 4000→14000, grass 18000→40000, bush 1500→2500
//   ② custom  : 同上(它自己的 cSpread/cMaxH2)
//   ③ island  : count 600→3000, 草/灌木给默认值
//   ④ vegdbg debug 层 + __vegdbg 钩子
const fs = require('fs');
const p = 'src/lib/game/engine.ts';
let s = fs.readFileSync(p, 'utf8');
function once(a, l) { const n = s.split(a).length - 1; if (n !== 1) { console.error('anchor miss', l, n); process.exit(1); } }

// ---- ① mountain ----
once('        const vegSpread = mTune?.veg?.spread ?? 18900;', 'spread');
s = s.replace('        const vegSpread = mTune?.veg?.spread ?? 18900;', [
  '        // === 铺开半径收窄 (per fix: 密度太低 ⇒ 从空中"一颗都看不到") ============',
  '        // 实测: 预算(几千株树 + 1.8 万株草)摊在 ±18.9km ≈ 1430km² 上 ⇒ 平均 1 株/3000m²,',
  '        // 最近的植被批离相机 **5.6km** —— 26m 的树在这个密度下就是看不见的点。',
  '        // 收到 ±7km(196km², 密度 ×7.3)并提高株数; 远处靠"距离剔除"控提交量。',
  '        const vegSpread = mTune?.veg?.spread ?? 7000;',
].join('\n'));

once('          count: mTune?.veg?.count ?? 4000,', 'count');
s = s.replace('          count: mTune?.veg?.count ?? 4000,', '          count: mTune?.veg?.count ?? 14000,');

once('          // 尺寸放大 14 倍(1.9m → 18m 树)之后, 原来的 6 万株草 / 2600 灌木密级过剩;\n          // 而且草是实例提交量的最大头(距离剔除只能救远处)。默认一起下调。\n          grassCount: mTune?.veg?.grassCount ?? 18000,\n          bushCount: mTune?.veg?.bushCount ?? 1500,',
  'counts');
s = s.replace('          // 尺寸放大 14 倍(1.9m → 18m 树)之后, 原来的 6 万株草 / 2600 灌木密级过剩;\n          // 而且草是实例提交量的最大头(距离剔除只能救远处)。默认一起下调。\n          grassCount: mTune?.veg?.grassCount ?? 18000,\n          bushCount: mTune?.veg?.bushCount ?? 1500,', [
  '          // 半径收到 ±7km 后, 同样株数密度高 7 倍; 再把三档都加上去, 目标是绿地能成"片"。',
  '          grassCount: mTune?.veg?.grassCount ?? 40000,',
  '          bushCount: mTune?.veg?.bushCount ?? 2500,',
].join('\n'));

// ---- ② custom ----
once('          count: vg?.count ?? 2000,', 'custom count');
s = s.replace('          count: vg?.count ?? 2000,', '          count: vg?.count ?? 6000,');
once('          grassCount: mTune?.veg?.grassCount,\n          bushCount: mTune?.veg?.bushCount,\n          vegMask,', 'custom counts');
s = s.replace('          grassCount: mTune?.veg?.grassCount,\n          bushCount: mTune?.veg?.bushCount,\n          vegMask,', [
  '          grassCount: mTune?.veg?.grassCount ?? 20000,',
  '          bushCount: mTune?.veg?.bushCount ?? 1500,',
  '          vegMask,',
].join('\n'));

// ---- ③ island ----
once('            count: mTune?.veg?.count ?? 600,', 'island count');
s = s.replace('            count: mTune?.veg?.count ?? 600,', '            count: mTune?.veg?.count ?? 3000,');
once('            grassCount: mTune?.veg?.grassCount,\n            bushCount: mTune?.veg?.bushCount,\n            vegMask: islandMask,', 'island counts');
s = s.replace('            grassCount: mTune?.veg?.grassCount,\n            bushCount: mTune?.veg?.bushCount,\n            vegMask: islandMask,', [
  '            grassCount: mTune?.veg?.grassCount ?? 15000,',
  '            bushCount: mTune?.veg?.bushCount ?? 1200,',
  '            vegMask: islandMask,',
].join('\n'));

// ---- ④ vegdbg ----
once('  private _vegTextures: Record<string, VegSpriteTexture | null> | null = null;', 'tex field');
s = s.replace('  private _vegTextures: Record<string, VegSpriteTexture | null> | null = null;',
  '  private _vegTextures: Record<string, VegSpriteTexture | null> | null = null;\n'
  + '  /** 植被 debug 层(控制台 vegdbg): 用不受遮挡的发光方块标出每一株的位置 */\n'
  + '  private _vegDebugLayer: THREE.Group | null = null;');

once('    // === 植被报告/切换 (per user request: 贴图自动适配) =============================', 'veg cmd anchor');
s = s.replace('    // === 植被报告/切换 (per user request: 贴图自动适配) =============================', [
  '    // === 植被 debug 层 (per user request: 帮我加个 debug 层看看树在哪里) =============',
  '    //   vegdbg / vegdbg off → 开关: 用**不受地形遮挡**的发光方块标出每株位置, 并报告',
  '    //   视野内株数 / 最近一株的距离与高差 / 各档剔除上限。',
  '    //   为什么 depthTest:false —— 树可能被地形/云挡住、甚至埋在别处, 这一层要穿透一切。',
  '    //   配色: 红=树 品红=雪松 黄=灌木 青=草 棕=树干。',
  '    {',
  '      const mv = mode.trim().toLowerCase().match(/^vegdbg(?:\\s+(\\S+))?$/);',
  '      if (mv) {',
  '        const off = mv[1] === \'off\' || mv[1] === \'0\';',
  '        if (this._vegDebugLayer) {',
  '          this.scene.remove(this._vegDebugLayer);',
  '          this._vegDebugLayer.traverse((o) => {',
  '            const im = o as THREE.InstancedMesh;',
  '            if (im.isInstancedMesh) { im.geometry.dispose(); (im.material as THREE.Material).dispose(); }',
  '          });',
  '          this._vegDebugLayer = null;',
  '        }',
  '        if (off) return \'植被 debug 层: OFF\';',
  '        return this.buildVegDebugLayer();',
  '      }',
  '    }',
  '    // === 植被报告/切换 (per user request: 贴图自动适配) =============================',
].join('\n'));

once('  /** 每帧植被距离剔除: 草/灌木/树各有上限(见 environment.ts 的 vegMaxDist) */', 'cull anchor');
s = s.replace('  /** 每帧植被距离剔除: 草/灌木/树各有上限(见 environment.ts 的 vegMaxDist) */', [
  '  /** 植被 debug 层: 把每株位置画成不受遮挡的发光方块(按种类配色), 只取相机 3km 内。 */',
  '  private buildVegDebugLayer(): string {',
  '    const cam = this.camera.camera.position;',
  '    const R = 3000, CAP = 8000;',
  '    const pts: { x: number; y: number; z: number; c: number }[] = [];',
  '    const stats: Record<string, number> = {};',
  '    let nearest = Infinity, nearestY = 0, nearestKind = \'\';',
  '    for (const f of this._vegFields) {',
  '      for (const chunk of f.children) {',
  '        for (const child of chunk.children) {',
  '          const mesh = child as THREE.InstancedMesh;',
  '          if (!mesh.isInstancedMesh || mesh.count === 0) continue;',
  '          const col = (mesh.material as THREE.MeshStandardMaterial).color;',
  '          const hex = col ? col.getHex() : 0xffffff;',
  '          const kind = hex === 0xffffff ? \'雪松\' : hex === 0x4a3520 ? \'树干\'',
  '            : hex === 0xa8d498 ? \'灌木\' : hex === 0x9fd8a0 ? \'针叶\'',
  '              : hex === 0xb8e0a0 ? \'阔叶\' : \'草/其它\';',
  '          const a = mesh.instanceMatrix.array;',
  '          for (let k = 0; k < mesh.count; k++) {',
  '            const o = k * 16;',
  '            const x = mesh.position.x + a[o + 12], y = mesh.position.y + a[o + 13], z = mesh.position.z + a[o + 14];',
  '            const d = Math.hypot(x - cam.x, y - cam.y, z - cam.z);',
  '            stats[kind] = (stats[kind] ?? 0) + 1;',
  '            if (d < nearest) { nearest = d; nearestY = y; nearestKind = kind; }',
  '            if (d <= R && pts.length < CAP) {',
  '              const cc = kind === \'雪松\' ? 0xff40ff : (kind === \'针叶\' || kind === \'阔叶\') ? 0xff2020',
  '                : kind === \'灌木\' ? 0xffd000 : kind === \'树干\' ? 0x8a6a3a : 0x00ffff;',
  '              pts.push({ x, y, z, c: cc });',
  '            }',
  '          }',
  '        }',
  '      }',
  '    }',
  '    const g = new THREE.Group();',
  '    g.userData.isVegDebug = true;',
  '    if (pts.length) {',
  '      const quad = new THREE.PlaneGeometry(1, 1);',
  '      const mat = new THREE.MeshBasicMaterial({',
  '        color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.85,',
  '        depthTest: false, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,',
  '      });',
  '      const inst = new THREE.InstancedMesh(quad, mat, pts.length);',
  '      inst.frustumCulled = false;',
  '      inst.renderOrder = 999;',
  '      const m4 = new THREE.Matrix4();',
  '      const q = new THREE.Quaternion();',
  '      const scl = new THREE.Vector3(8, 8, 8);',
  '      const pos = new THREE.Vector3();',
  '      const c = new THREE.Color();',
  '      for (let i = 0; i < pts.length; i++) {',
  '        pos.set(pts[i].x, pts[i].y + 8, pts[i].z);',
  '        m4.compose(pos, q, scl);',
  '        inst.setMatrixAt(i, m4);',
  '        inst.setColorAt(i, c.setHex(pts[i].c));',
  '      }',
  '      inst.instanceMatrix.needsUpdate = true;',
  '      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;',
  '      g.add(inst);',
  '    }',
  '    this.scene.add(g);',
  '    this._vegDebugLayer = g;',
  '    const near = Number.isFinite(nearest) ? `${Math.round(nearest)}m(${nearestKind} y=${Math.round(nearestY)})` : \'无\';',
  '    return `植被 debug 层: ON · 画出 ${pts.length} 枚(3km 内, 上限 ${CAP})\\n`',
  '      + `  最近一株: ${near} · 全场按种类: ${JSON.stringify(stats)}\\n`',
  '      + `  红=树 品红=雪松 黄=灌木 青=草 棕=树干 · 不受地形遮挡 · 再敲 vegdbg 关闭`;',
  '  }',
  '',
  '  /** 每帧植被距离剔除: 草/灌木/树各有上限(见 environment.ts 的 vegMaxDist) */',
].join('\n'));

once("      (window as any).__vcloud = (arg?: unknown) => this.setDebugView(`vcloud${arg === undefined ? '' : ` ${String(arg)}`}`);", 'hook');
s = s.replace("      (window as any).__vcloud = (arg?: unknown) => this.setDebugView(`vcloud${arg === undefined ? '' : ` ${String(arg)}`}`);",
  "      (window as any).__vcloud = (arg?: unknown) => this.setDebugView(`vcloud${arg === undefined ? '' : ` ${String(arg)}`}`);\n"
  + "      (window as any).__vegdbg = (arg?: unknown) => this.setDebugView(`vegdbg${arg === undefined ? '' : ` ${String(arg)}`}`);");

fs.writeFileSync(p, s);
console.log('§217 ok: 三条路径密度 + vegdbg');
