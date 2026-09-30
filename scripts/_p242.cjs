// §242: 关卡内实时过场运镜(开场展示主舰+周围轻型舰 / 末阶段坠落) + 过场台词占位槽
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
const T = 'src/lib/game/types.ts';
const H = 'src/components/game/Hud.tsx';

// ---------- ① HUD 负载加 cinematic 标志 ----------
rep(T, `  lockTargetScreen: { x: number; y: number } | null;`,
`  lockTargetScreen: { x: number; y: number } | null;
  /** true = 正在播关卡内过场运镜(HUD 画上下黑边, 让出画面给镜头) */
  cinematic?: boolean;`,
 'HudState.cinematic');

// ---------- ② 过场运镜控制器 ----------
rep(E, `  /** 友军战舰补位计时 + 型号交替计数 */`,
`  // === 关卡内实时过场运镜 (per user request: 进关卡先运镜展示 boss 与周围轻型舰; 坠落时再给一次) ==
  // 实现方式: 相机照常由 CameraRig 更新, 本控制器在**同一帧稍后**把 position/quaternion/fov 覆盖掉 ——
  // 于是不需要改相机模块, 播完自动交还控制权。镜头由"镜头表"(每段: 时长 + 目标 + 环绕参数)驱动。
  private cine: { kind: 'intro' | 'crash'; t: number; dur: number } | null = null;
  private cineLetterbox = false;
  private _cineLookM = new THREE.Matrix4();
  /** 友军战舰补位计时 + 型号交替计数 */`,
 '过场字段');

// ---------- ③ 启动 + 更新 + 镜头表 ----------
rep(E, `  /** 友军战舰补位: 场上活着的友军轻型舰少于 5 艘时, 每 18 秒补一艘(型号交替)。 */`,
`  /** 开场运镜 (per user request): 先围着敌方主舰转一圈展示体量, 再贴舰体掠过, 最后扫过它周围的轻型舰。 */
  private startIntroCutscene() {
    if (!this.isS01 || !this.boss) return;
    this.cine = { kind: 'intro', t: 0, dur: 17 };
    this.cineLetterbox = true;
    this.playS01CineBlock('intro', 3.6);
  }

  /** 坠落运镜 (per user request): 主舰开始坠落时给一次, 侧后跟拍 + 拉近看舰体, 直到接近触地。 */
  private startCrashCutscene() {
    if (!this.isS01 || !this.boss) return;
    this.cine = { kind: 'crash', t: 0, dur: 14 };
    this.cineLetterbox = true;
    this.playS01CineBlock('crash', 4.2);
  }

  /** 过场台词槽(占位符): 与其它剧情组同一套队列, 只是内容还是占位文本, 等填。 */
  private playS01CineBlock(key: 'intro' | 'crash', gap = 3.6) {
    const list = S01_CINEMATIC[key];
    if (!list) return;
    this.radio.triggerSequence(list, { gap });
  }

  /**
   * 过场运镜更新: 在主相机更新**之后**调用, 直接覆盖相机的位姿与 fov。
   * 镜头表(按 elapsed 时间分段, 段内平滑过渡):
   *   intro: ① 远景环绕主舰(看体量) ② 贴舰体由艉向艏掠过 ③ 环绕主舰周围的轻型舰 ④ 拉回高空交还
   *   crash: ① 侧后远景跟拍下坠 ② 拉近仰视舰体 ③ 远处看触地
   */
  private updateCutscene(dt: number) {
    const b = this.boss;
    if (!this.cine) { this.cineLetterbox = false; return; }
    if (!b || (!b.alive && this.cine.kind === 'intro')) { this.cine = null; this.cineLetterbox = false; return; }
    this.cine.t += dt;
    const cam = this.camera.camera;
    const V = THREE.Vector3;
    const half = this.bossModel ? this.bossModel.hullFrame.half : new V(1500, 1000, 4000);
    const shipQ = b.group.quaternion.clone();
    const fwd = new V(0, 0, 1).applyQuaternion(shipQ).normalize();
    const side = new V(1, 0, 0).applyQuaternion(shipQ).normalize();
    const up = new V(0, 1, 0);
    const t = this.cine.t;
    let camPos: THREE.Vector3;
    let look: THREE.Vector3;
    let fov = 55;
    if (this.cine.kind === 'intro') {
      if (t < 8) {
        // ① 远景环绕: 半径 1.5 倍舰长, 高度在舰体上方 0.8 倍半高
        const a = (t / 8) * Math.PI * 1.2 - Math.PI * 0.6;
        const r = half.z * 1.5;
        camPos = b.position.clone().addScaledVector(fwd, Math.cos(a) * r).addScaledVector(side, Math.sin(a) * r).add(up.clone().multiplyScalar(half.y * 1.6));
        look = b.position.clone().add(up.clone().multiplyScalar(half.y * 0.4));
        fov = 48;
      } else if (t < 13) {
        // ② 贴舰体掠过: 从艉端外侧沿长轴滑到艏端外侧, 视线盯着舰体
        const k = (t - 8) / 5;
        const along = -half.z * 1.05 + k * half.z * 2.1;
        camPos = b.position.clone().addScaledVector(fwd, along).addScaledVector(side, half.x * 1.15).addScaledVector(up, half.y * 0.35);
        look = b.position.clone().addScaledVector(fwd, along * 0.4).addScaledVector(up, half.y * 0.15);
        fov = 60;
      } else if (t < 16) {
        // ③ 扫过周围的轻型舰(找最近的一艘)
        const ships = this.groundUnits.filter((g) => g.alive && g.type === 'air_light');
        const target = ships.length > 0
          ? ships.reduce((best, s) => (s.position.distanceTo(b.position) < best.position.distanceTo(b.position) ? s : best), ships[0])
          : null;
        const anchor = target ? target.position : b.position;
        const a = (t - 13) / 3 * Math.PI * 0.9;
        camPos = anchor.clone().add(new V(Math.cos(a) * 900, 320, Math.sin(a) * 900));
        look = anchor.clone();
        fov = 52;
      } else {
        // ④ 拉回玩家身后(过渡一帧就交还, 由后续的相机更新自然接上)
        camPos = this.player.position.clone().addScaledVector(this.playerForward, -60).addScaledVector(up, 18);
        look = this.player.position.clone().addScaledVector(this.playerForward, 60);
        fov = 60;
      }
    } else {
      // crash: 跟拍下坠
      const along = t < 8 ? 1 : 0;   // 前 8 秒侧后远景, 之后拉近
      const r = along ? half.z * 1.35 : half.z * 0.55;
      const hgt = along ? half.y * 2.2 : half.y * 0.5;
      const a = 0.5 + t * 0.06;
      camPos = b.position.clone().addScaledVector(side, Math.cos(a) * r).addScaledVector(fwd, Math.sin(a) * r * 0.5).add(up.clone().multiplyScalar(hgt));
      look = b.position.clone().add(up.clone().multiplyScalar(half.y * 0.2));
      fov = along ? 46 : 58;
    }
    // 平滑: 与前一段的镜头用 lerp 过渡, 避免硬切(相机自己每帧被覆盖, 所以这里只做小幅惯量)
    cam.position.lerp(camPos, Math.min(1, dt * 6));
    this._cineLookM.lookAt(cam.position, look, up);
    cam.quaternion.slerp(new THREE.Quaternion().setFromRotationMatrix(this._cineLookM), Math.min(1, dt * 6));
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov += (fov - cam.fov) * Math.min(1, dt * 4);
      cam.updateProjectionMatrix();
    }
    if (this.cine.t >= this.cine.dur) { this.cine = null; this.cineLetterbox = false; }
  }

  /** 友军战舰补位: 场上活着的友军轻型舰少于 5 艘时, 每 18 秒补一艘(型号交替)。 */`,
 '运镜控制器');

// ---------- ④ 主循环里挂上(相机更新之后) ----------
rep(E, `    this.camera.update(dtCam, this.player.position, this.playerForward, this.playerUp, this.playerRight, this.playerSpeed, camMaxSpeed, this.playerGForce);
  }`,
`    this.camera.update(dtCam, this.player.position, this.playerForward, this.playerUp, this.playerRight, this.playerSpeed, camMaxSpeed, this.playerGForce);
    // 过场运镜: 在相机更新之后覆盖位姿(播完自动交还)
    this.updateCutscene(dtCam);
  }`,
 '主循环挂载');

// ---------- ⑤ 开局触发/坠落触发 ----------
rep(E, `    // 我方开场(基石/游隼/山雀...): 排在敌方那组后面, 免得两句叠在一起
    window.setTimeout(() => { if (this.isS01) this.playS01AllyBlock('s0_open', 4.2); }, 14000);`,
`    // 我方开场(基石/游隼/山雀...): 排在敌方那组后面, 免得两句叠在一起
    window.setTimeout(() => { if (this.isS01) this.playS01AllyBlock('s0_open', 4.2); }, 14000);
    // 开场运镜(per user request): 进关 2.5 秒后开始, 先展示敌方主舰与它周围的轻型舰
    window.setTimeout(() => { if (this.isS01 && !this.ended) this.startIntroCutscene(); }, 2500);`,
 '开场运镜触发');
rep(E, `    this.playS01Block('s5_fall', 5.2);`,
`    this.playS01Block('s5_fall', 5.2);
    // 坠落运镜(per user request): 主舰开始掉高度时给一次镜头
    window.setTimeout(() => { if (this.isS01) this.startCrashCutscene(); }, 1800);`,
 '坠落运镜触发');

// ---------- ⑥ HUD: 黑边 ----------
rep(E, `    this.cb.onHudUpdate({`,
`    this.cb.onHudUpdate({
      // 过场运镜期间画上下黑边(让出画面), 由 Hud.tsx 渲染
      // (放在最前, 后面的字段照旧)`,
 'HUD 传 cinematic(占位)');
rep(H, `      {hud.incomingLock && (`,
`      {/* === 过场运镜: 上下黑边 (per user request: 关卡内过场动画) === */}
      {hud.cinematic && (
        <>
          <div key="cine-top" className="pointer-events-none absolute inset-x-0 top-0 z-40 bg-black" style={{ height: '11%' }} />
          <div key="cine-bottom" className="pointer-events-none absolute inset-x-0 bottom-0 z-40 bg-black" style={{ height: '13%' }} />
          <div key="cine-note" className="pointer-events-none absolute bottom-[13%] left-1/2 z-40 -translate-x-1/2 text-[9px] tracking-[0.4em] text-[var(--crt-amber-dim)]">
            CINEMATIC
          </div>
        </>
      )}

      {hud.incomingLock && (`, 'HUD 黑边');

// ---------- ⑦ 台词占位槽数据 ----------
rep('src/lib/game/radio.ts', `  | 'story_s01_ally_s5_fall_06'`,
`  | 'story_s01_ally_s5_fall_06'
  // === 关卡内过场运镜的台词槽 (per user request: 预留过场动画台词位) ==================
  // 这些是**占位槽**: 文本写成"待填写"占位, 语音没有 mp3 => 运行时只显示字幕。
  // 要填内容: 直接改 LINES 里对应的 text/en(想配音再加 /audio/radio/<id>-0.mp3 即可), 不用改代码。
  | 'story_s01_cine_intro_01' | 'story_s01_cine_intro_02' | 'story_s01_cine_intro_03'
  | 'story_s01_cine_intro_04' | 'story_s01_cine_intro_05' | 'story_s01_cine_intro_06'
  | 'story_s01_cine_crash_01' | 'story_s01_cine_crash_02'
  | 'story_s01_cine_crash_03' | 'story_s01_cine_crash_04'`,
 '过场台词事件(联合)');
console.log('§242 1/2 done');
