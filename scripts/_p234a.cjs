// §234a: 音乐"同时只播一首"的不变量 + 任务栏就播简报曲 + 主舰再翻倍 + 主舰碰撞体积
const fs = require('fs');
function rep(file, a, b, label, all) {
  let s = fs.readFileSync(file, 'utf8');
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip:', label); return; }
  if (!all && n !== 1) { console.error('miss(' + n + ') ' + file + ':', label); process.exit(1); }
  fs.writeFileSync(file, all ? s.split(a).join(b) : s.replace(a, b));
  console.log('ok:', label, all ? '(' + n + ')' : '');
}
const M = 'src/lib/game/music.ts';
const G = 'src/components/game/GameApp.tsx';
const D = 'src/lib/game/dreadnought.ts';
const E = 'src/lib/game/engine.ts';

// ---------- ① 音乐: 去掉重复的"剧情战斗曲"元素 + 强制"同时只有一首在播" ----------
rep(M, `  private briefingEl: HTMLAudioElement | null = null;
  private storyCombatEl: HTMLAudioElement | null = null;
  /** true = 当前关卡用剧情专属战斗曲(White Bird) */
  private storyCombat = false;`,
`  private briefingEl: HTMLAudioElement | null = null;
  /** true = 当前关卡用剧情专属战斗曲(现在全局就是 White Bird, 这个开关留着兼容调用方) */
  private storyCombat = false;`, '去掉 storyCombatEl 字段');

rep(M, `    this.storyCombatEl = new Audio(STORY_COMBAT_TRACK);
    this.storyCombatEl.loop = true;
    this.storyCombatEl.preload = 'none';
    this.storyCombatEl.volume = 0;
`, '', '去掉 storyCombatEl 创建');

rep(M, `  /** Pick a random combat track for the upcoming mission. */
  pickCombatTrack() {
    if (this.storyCombat && this.storyCombatEl) {
      // 剧情关: 固定 White Bird, 不走随机池
      this.storyCombatEl.load();
      this.currentCombat = this.storyCombatEl;
      return;
    }
    const idx = Math.floor(Math.random() * this.combatEls.length);
    this.currentCombat = this.combatEls[idx] ?? null;`,
`  /** Pick the combat track for the upcoming mission.
   *  === 同时只能有一首音乐在播 (per user request) ==============================
   *  之前剧情关另建了一个 White Bird 元素, 而战斗池里也是同一首 —— 两条元素会**同时出声**
   *  (差几十毫秒, 听起来像回声/双音)。现在统一走池子里的那一个元素, 并在每次切轨时调用
   *  enforceSingleTrack() 兜底: 除当前轨外的所有元素一律 pause。
   *  \`storyCombat\` 开关保留(调用方还在用), 但两个分支取的是同一个元素。 */
  pickCombatTrack() {
    const idx = this.storyCombat ? 0 : Math.floor(Math.random() * this.combatEls.length);
    this.currentCombat = this.combatEls[Math.min(idx, this.combatEls.length - 1)] ?? null;`, 'pickCombatTrack 单元素');

rep(M, `  setTrack(track: TrackName, fadeMs = 1500) {    if (!this.started) this.init();`,
`  /** 除当前轨道外, 其它音乐元素一律停掉(不变量: 任何时刻只有一首音乐在播)。 */
  private enforceSingleTrack(active: TrackName) {
    const keep = new Set<HTMLAudioElement>();
    if (active === 'menu' && this.menuEl) keep.add(this.menuEl);
    if (active === 'briefing' && this.briefingEl) keep.add(this.briefingEl);
    if (active === 'combat' && this.currentCombat) keep.add(this.currentCombat);
    for (const el of [this.menuEl, this.briefingEl, this.currentCombat, ...this.combatEls]) {
      if (!el || keep.has(el)) continue;
      if (!el.paused) el.pause();
      el.volume = 0;
    }
  }

  setTrack(track: TrackName, fadeMs = 1500) {    if (!this.started) this.init();
    this.enforceSingleTrack(track);`, 'setTrack 强制单轨');

rep(M, `    this.briefingEl?.pause();
    this.storyCombatEl?.pause();`, `    this.briefingEl?.pause();`, 'dispose 去掉 storyCombatEl');

// ---------- ② 任务栏(剧情关卡列表)就播简报曲 ----------
rep(G, `    // === 简报界面换专属曲 (per user request: 进入简报界面就换成这个 briefing 音乐) ====
    if (phase === 'story-brief') {
      getMusicPlayer().setTrack('briefing', 900);
    } else if (phase === 'menu' || phase === 'mission-select' || phase === 'story-select'`,
`    // === 任务列表/简报界面都换简报曲 (per user request: 点任务栏就播简报音乐, 菜单音乐停) ====
    // story-select = 正式版剧情的关卡列表 —— 从这一屏开始就不再放菜单曲了。
    if (phase === 'story-brief' || phase === 'story-select') {
      getMusicPlayer().setTrack('briefing', 900);
    } else if (phase === 'menu' || phase === 'mission-select'`,
 '任务栏播简报曲');

// ---------- ③ 主舰模型再翻倍 ----------
rep(D, `export const DREADNOUGHT_SCALE = Math.cbrt(3) * 3;`,
`// 体积 x3(第一轮) -> 长宽高 x3(第二轮) -> **这一轮再翻倍** (per user request: 模型大小还得翻倍)
// => cbrt(3) x 3 x 2 = 8.653, 基础 900x240x160 变成约 7788x2077x1384 米。
export const DREADNOUGHT_SCALE = Math.cbrt(3) * 3 * 2;`,
 '主舰再翻倍');

// ---------- ④ 主舰碰撞体积: 玩家进入舰体盒 = 撞上 ----------
rep(E, `        // 舰体矩阵当帧刷新: 16 个挂点单位在**同一帧**里用它算世界坐标(不刷新会滞后一帧)
        u.group.updateMatrixWorld(true);
        continue;   // 主舰不走地面逻辑, 也不走轻型舰的组件台账`,
`        // 舰体矩阵当帧刷新: 16 个挂点单位在**同一帧**里用它算世界坐标(不刷新会滞后一帧)
        u.group.updateMatrixWorld(true);
        // === 主舰**碰撞体积** (per user request: 这个 fbx 模型有碰撞体积) ==========
        // 把玩家位置变换到舰体本地空间, 与舰体盒(hullFrame: 长宽取满, 高只取舰体那一条)做包含测试;
        // 撞进去就: 沿最近的面把玩家推出去 + 持续掉血 + 剧烈晃动/红闪 + 一条提示。
        // 用冷却节流, 免得贴脸时每帧都播提示。
        if (this.playerHp > 0 && this.bossModel) {
          const half = this.bossModel.hullFrame.half;
          _bossInv.copy(u.group.matrixWorld).invert();
          _bossLocal.copy(this.player.position).applyMatrix4(_bossInv).sub(this.bossModel.hullFrame.center);
          const ax = Math.abs(_bossLocal.x), ay = Math.abs(_bossLocal.y), az = Math.abs(_bossLocal.z);
          if (ax < half.x && ay < half.y && az < half.z) {
            // 最近的面 = 出射方向
            const dx = half.x - ax, dy = half.y - ay, dz = half.z - az;
            if (dx <= dy && dx <= dz) _bossPush.set(Math.sign(_bossLocal.x) || 1, 0, 0);
            else if (dy <= dz) _bossPush.set(0, Math.sign(_bossLocal.y) || 1, 0);
            else _bossPush.set(0, 0, Math.sign(_bossLocal.z) || 1);
            _bossPush.applyQuaternion(u.group.quaternion).normalize();
            this.player.position.addScaledVector(_bossPush, 90 * dt);   // 推出去(压过飞行模型的位移)
            this.playerHp -= 45 * dt;
            this.camera.addShake(1.4);
            this.damageFlash = Math.min(1, this.damageFlash + 1.6 * dt);
            this.playerHitShakeT = Math.max(this.playerHitShakeT, 0.5);
            if (this.bossCrashT <= 0) {
              this.bossCrashT = 2.5;
              this.showMessage('撞上「堡垒」舰体!', 1.4);
            }
          }
        }
        if (this.bossCrashT > 0) this.bossCrashT -= dt;
        continue;   // 主舰不走地面逻辑, 也不走轻型舰的组件台账`,
 '主舰碰撞体积');

rep(E, `  /** 末阶段后燃器: 视觉组 + 是否已点火(只播一次轰鸣) */`,
`  /** 主舰撞机提示的节流计时 */
  private bossCrashT = 0;
  /** 末阶段后燃器: 视觉组 + 是否已点火(只播一次轰鸣) */`,
 'bossCrashT 字段');
console.log('§234a 1/2 done');
