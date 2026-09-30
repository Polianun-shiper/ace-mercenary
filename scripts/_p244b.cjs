// §244b: 过场运镜改成"关键帧轨道" —— 电影感(缓入缓出 + 焦距 32~70 切换 + 轻手持漂移 + 推拉)
const fs = require('fs');
const E = 'src/lib/game/engine.ts';
const src = fs.readFileSync(E, 'utf8');
const startMark = '    const t = this.cine.t;';
const endMark = '    // 位置/朝向/焦距都用较高跟随率贴关键帧';
// 兼容旧注释结尾(上一轮的措辞)
const endMark2 = '    cam.position.lerp(camPos, Math.min(1, dt * 6));';
const i0 = src.indexOf(startMark);
let i1 = src.indexOf(endMark);
if (i1 < 0) i1 = src.indexOf(endMark2);
if (i0 < 0 || i1 < 0) { console.error('镜头段落定位失败', i0, i1); process.exit(1); }

const NEW = `    const t = this.cine.t;
    // === 电影感运镜: 关键帧轨道 (per user request: 运镜要有电影感) ====================
    // 与简报界面同一套做法: 每个镜头记若干关键帧(机位 + 视点 + 焦距), 段内 smoothstep 缓入缓出、
    // 段间不硬切; 再叠一点**手持漂移**(低频正弦)和缓慢推拉 —— 于是不像"贴着公式转圈",
    // 而像摄影师在掌机。焦距在 30~70 之间切换(广角交代体量 / 长焦压缩空间)是电影感的主要来源。
    const ease = (x: number) => x * x * (3 - 2 * x);
    const mix = (a: number, b2: number, k: number) => a + (b2 - a) * k;
    const drift = (seed: number, amt: number) => {
      const w = performance.now() / 1000;
      return new V(
        Math.sin(w * 0.7 + seed) * amt,
        Math.sin(w * 0.53 + seed * 1.7) * amt * 0.6,
        Math.cos(w * 0.61 + seed * 2.3) * amt,
      );
    };
    // 关键帧: [时间, 机位(舰体 前/上/侧 的倍数), 视点(前/上 的倍数), 焦距]
    type CineKey = [number, [number, number, number], [number, number], number];
    const keys: CineKey[] = this.cine.kind === 'intro'
      ? [
        [0, [3.2, 1.2, 2.6], [0.20, 0.30], 32],     // 超远全景(广角): 交代"这东西有多大"
        [7, [1.6, 0.7, 1.2], [0.00, 0.12], 40],     // 缓推近
        [7.3, [-1.15, 1.25, 0.42], [0.10, 0.10], 62], // 切长焦: 低机位贴舰体(从艉)
        [13.5, [1.15, 1.05, 0.30], [-0.10, 0.06], 70], // 沿舰体滑到艏(长焦压缩)
        [14, [0.35, 3.0, 0.10], [0.00, 0.00], 46],  // 切到最近的轻型舰: 近景
        [16.6, [0.35, 3.4, -0.15], [0.00, 0.00], 40], // 缓慢横移收尾
      ]
      : [
        [0, [1.5, 4.0, 0.55], [0.15, 0.25], 34],    // 坠落: 侧后远景长焦
        [6, [1.9, 5.2, 0.15], [0.05, 0.20], 30],    // 缓缓横移拉开
        [10, [0.7, 1.1, 0.35], [0.00, 0.05], 54],   // 拉近
        [14, [0.35, 0.55, 0.30], [0.00, 0.00], 66], // 低机位仰视舰体
      ];
    // 定位当前段(smoothstep 段内插值)
    let seg = 0;
    while (seg < keys.length - 2 && t > keys[seg + 1][0]) seg++;
    const k0 = keys[seg];
    const k1 = keys[Math.min(seg + 1, keys.length - 1)];
    const span = Math.max(0.001, k1[0] - k0[0]);
    const kk = ease(Math.min(1, Math.max(0, (t - k0[0]) / span)));
    // 最后一段以"最近的轻型舰"为锚点(围着它拍)
    let anchor = b.position;
    if (this.cine.kind === 'intro' && t >= 14) {
      const ships = this.groundUnits.filter((g) => g.alive && g.type === 'air_light');
      if (ships.length > 0) {
        anchor = ships.reduce((best, s) => (s.position.distanceTo(b.position) < best.position.distanceTo(b.position) ? s : best), ships[0]).position;
      }
    }
    const boxOf = (arr: [number, number, number]) => new V(arr[0] * half.z, arr[1] * half.y, arr[2] * half.x);
    const pA = boxOf(k0[1]);
    const pB = boxOf(k1[1]);
    const camPos = anchor.clone()
      .addScaledVector(fwd, mix(pA.x, pB.x, kk))
      .addScaledVector(up, mix(pA.y, pB.y, kk))
      .addScaledVector(side, mix(pA.z, pB.z, kk))
      .add(drift(1.7, half.z * 0.012));
    const look = anchor.clone()
      .addScaledVector(fwd, mix(k0[2][0], k1[2][0], kk) * half.z)
      .addScaledVector(up, mix(k0[2][1], k1[2][1], kk) * half.y);
    const fov = mix(k0[3], k1[3], kk);
`;
let out = src.slice(0, i0) + NEW + src.slice(i1);
out = out.replace('    cam.position.lerp(camPos, Math.min(1, dt * 6));',
  '    // 漂移已经给了"手持感", 这里用较高跟随率贴关键帧, 别再抖第二次\n    cam.position.lerp(camPos, Math.min(1, dt * 9));');
out = out.replace('    cam.quaternion.slerp(new THREE.Quaternion().setFromRotationMatrix(this._cineLookM), Math.min(1, dt * 6));',
  '    cam.quaternion.slerp(new THREE.Quaternion().setFromRotationMatrix(this._cineLookM), Math.min(1, dt * 9));');
out = out.replace('      cam.fov += (fov - cam.fov) * Math.min(1, dt * 4);',
  '      cam.fov += (fov - cam.fov) * Math.min(1, dt * 6);');
// 清掉可能残留的旧 fov 变量声明(如果 NEW 之外还有 `let fov = 55;`)
out = out.replace('    let fov = 55;\n', '');
fs.writeFileSync(E, out);
console.log('ok: 关键帧电影运镜写入');
