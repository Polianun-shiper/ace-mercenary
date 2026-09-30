// §231a(2): 轰鸣 SFX 的播放分支(前半段 / 可循环一段时间) + init 里创建元素
const fs = require('fs');
const M = 'src/lib/game/music.ts';
function rep(a, b, label) {
  let s = fs.readFileSync(M, 'utf8');
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip:', label); return; }
  if (n !== 1) { console.error('miss(' + n + '):', label); process.exit(1); }
  fs.writeFileSync(M, s.replace(a, b));
  console.log('ok:', label);
}

// init: 创建轰鸣元素(与其它小 SFX 一样预加载, 体积只有 0.7MB)
rep(`  /** Play a one-shot SFX. Type selects which file. */`,
`  /**
   * 主舰末阶段开加力的轰鸣 (per user request: 用 transport-space 的前半段)。
   * 单独一个方法而不是塞进 playSfx: 它要**播满一段时长**(加力持续多久就响多久),
   * 所以这里克隆元素、从头播、到点停, 期间不参与 4 秒自动回收。
   */
  playShuttleRumble(seconds = 6): void {
    if (!this.started) return;
    const src = this.sfxShuttleRumbleEl;
    if (!src) return;
    if (src.readyState === 0) { try { src.load(); } catch { /* ignore */ } return; }
    const clone = src.cloneNode() as HTMLAudioElement;
    clone.volume = Math.max(0, Math.min(1, this.sfxVolume * 0.9));
    clone.currentTime = 0;
    clone.play().catch(() => { /* ignore autoplay errors */ });
    window.setTimeout(() => { clone.pause(); clone.src = ''; }, Math.max(1000, seconds * 1000));
  }

  /** Play a one-shot SFX. Type selects which file. */`,
 'playShuttleRumble 方法');

// 元素创建: 跟着其它 SFX 一起(找已存在的 SFX 初始化行插入)
rep(`    this.sfxWeaponSwitchEl = new Audio(assetUrl('/audio/sfx_weapon_switch.mp3'));`,
`    this.sfxWeaponSwitchEl = new Audio(assetUrl('/audio/sfx_weapon_switch.mp3'));
    // 主舰加力轰鸣: 素材是"航天飞机远处点火"的低频轰鸣, 只用前半段(见 playShuttleRumble)
    this.sfxShuttleRumbleEl = new Audio(assetUrl('/audio/sfx_shuttle_rumble.mp3'));
    this.sfxShuttleRumbleEl.preload = 'auto';`,
 'init 创建轰鸣元素');
