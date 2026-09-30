// §243: ① 友军战舰环绕半径压到"自己武器射程之内" ② MiG-29 尾焰小两圈
//       ③ 过场用**独立相机**(cineCamera)渲染, 结束后切回玩家相机
const fs = require('fs');
function rep(file, a, b, label, all) {
  let s = fs.readFileSync(file, 'utf8');
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip:', label); return; }
  if (!all && n !== 1) { console.error('miss(' + n + ') ' + file + ':', label); process.exit(1); }
  fs.writeFileSync(file, all ? s.split(a).join(b) : s.replace(a, b));
  console.log('ok:', label, all ? '(' + n + ')' : '');
}
const E = 'src/lib/game/engine.ts';

// ---------- ① 环绕半径受自己射程约束 ----------
rep(E, `          if (u.isAlly) {
            const boss = this.boss;
            if (boss && boss.alive) {
              seekPos = boss.position;
              seekRadius = Math.max(3200, (boss.collideR ?? 1200) * 1.9);
            } else {
              const t = this.pickAirTarget(u.position, true, 22000);
              if (t) { seekPos = t.position; seekRadius = Math.max(2200, ((t as unknown as GroundUnit).collideR ?? 300) * 2.2); }
            }
          } else {
            const t = this.pickAirTarget(u.position, false, 22000);
            if (t) { seekPos = t.position; seekRadius = Math.max(2200, ((t as unknown as GroundUnit).collideR ?? 300) * 2.2); }
          }`,
`          // === 环绕半径必须落进**自己武器的射程之内** (per user request: 不然他们围着却不打) =====
          // 我方挂点的射程 = u.radarRange(见 spawnAirWarship/components, 已提到 9km)。主舰是
          // 近 10 公里的巨物, 之前按 collideR x 1.9 算出来的环绕半径(6km+)已经贴着射程上限,
          // 于是炮口够不到目标 => 看着"只绕不打"。现在把半径钳到射程的 72% 以内, 并且不小于
          // 目标半对角线 + 600m(免得切进舰体)。
          const ownRange = (u.radarRange && u.radarRange > 0 ? u.radarRange : 5200);
          const clampOrbit = (target: GroundUnit | null) => {
            const collide = (target?.collideR ?? 300);
            const minSafe = collide * 0.62 + 600;         // 贴着舰体外一点点
            const maxUse = ownRange * 0.72;               // 射程内
            return Math.max(minSafe, Math.min(collide * 1.25, maxUse));
          };
          if (u.isAlly) {
            const boss = this.boss;
            if (boss && boss.alive) {
              seekPos = boss.position;
              seekRadius = clampOrbit(boss);
            } else {
              const t = this.pickAirTarget(u.position, true, 22000);
              if (t) { seekPos = t.position; seekRadius = clampOrbit(t as unknown as GroundUnit); }
            }
          } else {
            const t = this.pickAirTarget(u.position, false, 22000);
            if (t) { seekPos = t.position; seekRadius = clampOrbit(t as unknown as GroundUnit); }
          }`,
 '环绕半径进射程');

// 轻型舰挂点射程 5200 -> 9000(要够得着 10 公里级的巨舰)
rep(E, `          radarRange: 5200,
          // 组件不进海迹/地面灰尘/自主巡逻那几条分支, 但字段留全, 免得别处读到 undefined -> NaN`,
`          // 9km: 主舰是近 10 公里的巨物, 挂点不放到 9km 就永远够不着它(per user request)
          radarRange: 9000,
          // 组件不进海迹/地面灰尘/自主巡逻那几条分支, 但字段留全, 免得别处读到 undefined -> NaN`,
 '轻型舰挂点射程 9km');

// ---------- ② MiG-29 尾焰小两圈 ----------
rep(E, `    applyNozzleAlign(this.playerAfterburner, meshScale);`,
`    applyNozzleAlign(this.playerAfterburner, meshScale);
    // === MiG-29 的尾焰小两圈 (per user request) ==================================
    // 它的喷口比 F-16 粗, 同一套 nozzleMetrics 出来的火焰偏大 —— 整组缩到 0.6(观感约"小两圈")。
    // 只缩主玩家机(机库/敌机走各自路径), 想微调改这个系数即可。
    if (isMig29) this.playerAfterburner.scale.multiplyScalar(0.6);`,
 'MiG-29 尾焰缩小');

// ---------- ③ 独立过场相机 ----------
rep(E, `  private cine: { kind: 'intro' | 'crash'; t: number; dur: number } | null = null;
  private cineLetterbox = false;`,
`  private cine: { kind: 'intro' | 'crash'; t: number; dur: number } | null = null;
  private cineLetterbox = false;
  /** 过场专用相机 (per user request: 不要复用玩家相机, 单独一个运镜相机, 播完切回玩家视角) */
  private cineCamera: THREE.PerspectiveCamera | null = null;`,
 '过场相机字段');

rep(E, `    this.cine.t += dt;
    const cam = this.camera.camera;`,
`    this.cine.t += dt;
    // 独立相机(懒创建): 与玩家相机同宽高比即可, 播完就停用、不会污染追尾相机
    if (!this.cineCamera) {
      const p = this.camera.camera;
      this.cineCamera = new THREE.PerspectiveCamera(p.fov, p.aspect, p.near, p.far);
      this.cineCamera.name = 'cineCamera';
    }
    const cam = this.cineCamera;`,
 '过场用独立相机');

rep(E, `    cam.position.lerp(camPos, Math.min(1, dt * 6));`,
`    cam.position.lerp(camPos, Math.min(1, dt * 6));`, 'noop');

// 渲染与 HUD 用"当前活跃相机"
rep(E, `      this.renderer.render(this.scene, this.camera.camera);`,
`      this.renderer.render(this.scene, this.activeCamera());`, '离屏渲染用活跃相机');
rep(E, `    const renderPass = new RenderPass(this.scene, this.camera.camera);`,
`    const renderPass = new RenderPass(this.scene, this.camera.camera);`, 'noop2');

rep(E, `  /** 过场台词槽(占位符): 与其它剧情组同一套队列, 只是内容还是占位文本, 等填。 */`,
`  /**
   * 当前用于渲染/HUD 投影的相机: 过场期间是专用 cineCamera, 其余时候是玩家追尾相机。
   * (per user request: 过场运镜不要再动玩家相机, 射完切回玩家视角)
   */
  private activeCamera(): THREE.Camera {
    if (this.cine && this.cineCamera) return this.cineCamera;
    return this.camera.camera;
  }

  /** 过场台词槽(占位符): 与其它剧情组同一套队列, 只是内容还是占位文本, 等填。 */`,
 'activeCamera');
console.log('§243 1/2 done');
