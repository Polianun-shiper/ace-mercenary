// §217: ① 植被密度(这才是"一颗都看不到"的真因: 最近的植被批在 5.6km 外);
//       ② 控制台 debug 层 vegdbg(用户要求: 看看树在哪里);
//       ③ 高度雾的深度调试 + 地形遮挡核对。
const fs = require('fs');

// ---------- ① 密度: 收窄铺开半径 + 提高株数 ----------
{
  const p = 'src/lib/game/engine.ts';
  let s = fs.readFileSync(p, 'utf8');
  function once(a, l) { const n = s.split(a).length - 1; if (n !== 1) { console.error('miss', l, n); process.exit(1); } }
  const a = '        const vegSpread = mTune?.veg?.spread ?? 18900;';
  once(a, 'vegSpread');
  s = s.replace(a, [
    '        // === 铺开半径收窄 (per fix: 密度太低 ⇒ 从空中"一颗都看不到") ============',
    '        // 实测: 预算(几千株树 + 1.8 万株草)摊在 ±18.9km ≈ 1430km² 上 ⇒ 平均 1 株/3000m²,',
    '        // 最近的植被批离相机 **5.6km** —— 26m 的树在这个密度下就是看不见的点。',
    '        // 现在收到 ±7km(196km², 密度 ×7.3), 同时提高株数; 远处靠"距离剔除"控提交量。',
    '        const vegSpread = mTune?.veg?.spread ?? 7000;',
  ].join('\n'));
  const b = '          // 尺寸放大 14 倍(1.9m → 18m 树)之后, 原来的 6 万株草 / 2600 灌木密级过剩;\n          // 而且草是"实例提交量"的最大头(距离剔除只能救远处)。默认一起下调。\n          grassCount: mTune?.veg?.grassCount ?? 18000,\n          bushCount: mTune?.veg?.bushCount ?? 1500,';
  once(b, 'counts2');
  s = s.replace(b, [
    '          // 铺开半径收到 ±7km 之后, 同样的株数密度高 7 倍; 这里再把树/草/灌木都加上去,',
    '          // 目标: 绿地/岩地能成"片", 而不是撒在 1430km² 上的孤点。',
    '          grassCount: mTune?.veg?.grassCount ?? 40000,',
    '          bushCount: mTune?.veg?.bushCount ?? 2500,',
  ].join('\n'));
  const c = '          count: mTune?.veg?.count ?? 4000,';
  once(c, 'treeCount');
  s = s.replace(c, '          count: mTune?.veg?.count ?? 14000,');
  fs.writeFileSync(p, s);
  console.log('① 密度: spread 18900 -> 7000, 树 4000->14000, 草 18000->40000, 灌木 1500->2500');
}

// ---------- ② 控制台 debug 层: vegdbg ----------
{
  const p = 'src/lib/game/engine.ts';
  let s = fs.readFileSync(p, 'utf8');
  function once(a, l) { const n = s.split(a).length - 1; if (n !== 1) { console.error('miss', l, n); process.exit(1); } }
  // 字段
  const f = '  private _vegTextures: Record<string, VegSpriteTexture | null> | null = null;';
  once(f, 'veg tex field');
  s = s.replace(f, [
    f,
    '  /** 植被 debug 层(控制台 vegdbg): 用不受遮挡的发光方块标出每一株的位置 */',
    '  private _vegDebugLayer: THREE.Group | null = null;',
  ].join('\n'));
  // 方法 + 命令
  const anchor = "    // === 植被报告/切换 (per user request: 贴图自动适配) =============================";
  once(anchor, 'veg cmd');
  s = s.replace(anchor, [
    '    // === 植被 debug 层 (per user request: 帮我在控制台里加个 debug 层看看树在哪里) =====',
    '    //   vegdbg        → 开关: 用**不受地形遮挡**的发光方块标出每株的位置(按种类配色),',
    '    //                   同时报告: 视野内株数 / 最近一株的距离与高差 / 各档剔除上限。',
    '    //   为什么用 depthTest:false: 树可能被地形/云挡住, 或者干脆埋在别处 —— 这个层要能',
    '    //   穿透一切告诉你"它在哪"。颜色: 树=红 雪松=品红 灌木=黄 草=青。',
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
    '        const built = this.buildVegDebugLayer();',
    '        return built;',
    '      }',
    '    }',
    anchor,
  ].join('\n'));

  // buildVegDebugLayer 实现
  const put = '  /** 每帧植被距离剔除: 草/灌木/树各有上限(见 environment.ts 的 vegMaxDist) */';
  once(put, 'cull method');
  s = s.replace(put, [
    '  /**',
    '   * 植被 debug 层: 把每株的位置画成一枚**不受遮挡**的发光方块(按种类配色)。',
    '   * 只取相机 3km 内的株(最多 8000), 所以切换一下就能看清身边到底有没有植被、在哪。',
    '   */',
    '  private buildVegDebugLayer(): string {',
    '    const cam = this.camera.camera.position;',
    '    const R = 3000, CAP = 8000;',
    '    const pts: { x: number; y: number; z: number; c: number }[] = [];',
    '    const stats: Record<string, number> = {};',
    '    let nearest = Infinity, nearestY = 0, nearestKind = \'\';',
    '    for (const f of this._vegFields) {',
    '      for (const chunk of f.children) {',
    '        for (const im of chunk.children) {',
    '          const mesh = im as THREE.InstancedMesh;',
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
    '              const cc = kind === \'雪松\' ? 0xff40ff : kind === \'针叶\' || kind === \'阔叶\' ? 0xff2020',
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
    put,
  ].join('\n'));

  // devtools 钩子
  const hook = "      (window as any).__vcloud = (arg?: unknown) => this.setDebugView(`vcloud${arg === undefined ? '' : ` ${String(arg)}`}`);";
  once(hook, 'vcloud hook');
  s = s.replace(hook, hook + "\n      (window as any).__vegdbg = (arg?: unknown) => this.setDebugView(`vegdbg${arg === undefined ? '' : ` ${String(arg)}`}`);");
  fs.writeFileSync(p, s);
  console.log('② vegdbg debug 层 + __vegdbg 钩子 ok');
}
