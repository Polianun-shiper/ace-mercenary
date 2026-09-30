// §231a: music.ts —— 简报曲 / 剧情关卡战斗曲(White Bird) / 主舰加力轰鸣
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

rep(`export type TrackName = 'menu' | 'combat' | 'none';`,
`// 'briefing' = 3D 简报界面专属曲(per user request: 进简报就换这首)
export type TrackName = 'menu' | 'combat' | 'briefing' | 'none';`,
 'TrackName += briefing');

rep(`const COMBAT_TRACKS = [
  assetUrl('/audio/music_vitoze.mp3'),
] as const;`,
`const COMBAT_TRACKS = [
  assetUrl('/audio/music_vitoze.mp3'),
] as const;

// === 正式版剧情第一关: 关卡专属战斗曲 + 简报曲 (per user request) ================
// 这一关的战斗曲不用随机池里的, 固定播用户给的 White Bird(Part II);
// 简报界面单独一首(高橋コウタ - Briefing), 退出简报就淡出。
const STORY_COMBAT_TRACK = assetUrl('/audio/music_white_bird.mp3');
const BRIEFING_TRACK = assetUrl('/audio/music_briefing.mp3');`,
 '曲目常量');

rep(`  private menuEl: HTMLAudioElement | null = null;
  private combatEls: HTMLAudioElement[] = [];`,
`  private menuEl: HTMLAudioElement | null = null;
  private briefingEl: HTMLAudioElement | null = null;
  private storyCombatEl: HTMLAudioElement | null = null;
  /** true = 当前关卡用剧情专属战斗曲(White Bird) */
  private storyCombat = false;
  private combatEls: HTMLAudioElement[] = [];`,
 '播放器字段');

rep(`    this.menuEl = new Audio(MENU_TRACK);`,
`    // 简报曲与剧情战斗曲: 按需加载(与其它长曲一致, preload='none')
    this.briefingEl = new Audio(BRIEFING_TRACK);
    this.briefingEl.loop = true;
    this.briefingEl.preload = 'none';
    this.briefingEl.volume = 0;
    this.storyCombatEl = new Audio(STORY_COMBAT_TRACK);
    this.storyCombatEl.loop = true;
    this.storyCombatEl.preload = 'none';
    this.storyCombatEl.volume = 0;
    this.menuEl = new Audio(MENU_TRACK);`,
 'init 创建简报/剧情曲');

rep(`  /** Pick a random combat track for the upcoming mission. */
  pickCombatTrack() {
    const idx = Math.floor(Math.random() * this.combatEls.length);
    this.currentCombat = this.combatEls[idx] ?? null;`,
`  /** 这一关是不是用剧情专属战斗曲(引擎在 startMission 里调)。 */
  useStoryCombat(on: boolean) {
    if (this.storyCombat === on) return;
    this.storyCombat = on;
    this.currentCombat = null;   // 强制下一帧重挑
    this.current = 'none';
  }

  /** Pick a random combat track for the upcoming mission. */
  pickCombatTrack() {
    if (this.storyCombat && this.storyCombatEl) {
      // 剧情关: 固定 White Bird, 不走随机池
      this.storyCombatEl.load();
      this.currentCombat = this.storyCombatEl;
      return;
    }
    const idx = Math.floor(Math.random() * this.combatEls.length);
    this.currentCombat = this.combatEls[idx] ?? null;`,
 'pickCombatTrack 支持剧情曲');

rep(`    const menuStart = this.menuEl?.volume ?? 0;
    const combatStart = this.currentCombat?.volume ?? 0;
    const menuTarget = track === 'menu' ? this.targetVolume : 0;
    const combatTarget = track === 'combat' ? this.targetVolume : 0;`,
`    const menuStart = this.menuEl?.volume ?? 0;
    const combatStart = this.currentCombat?.volume ?? 0;
    const briefStart = this.briefingEl?.volume ?? 0;
    const menuTarget = track === 'menu' ? this.targetVolume : 0;
    const combatTarget = track === 'combat' ? this.targetVolume : 0;
    const briefTarget = track === 'briefing' ? this.targetVolume : 0;`,
 '淡入淡出起点');

rep(`    if (track === 'combat' && this.currentCombat) {
      this.currentCombat.play().catch(() => {});
    }`,
`    if (track === 'combat' && this.currentCombat) {
      this.currentCombat.play().catch(() => {});
    }
    if (track === 'briefing' && this.briefingEl) {
      this.briefingEl.play().catch(() => {});
    }`,
 '简报起播');

rep(`      if (this.menuEl) this.menuEl.volume = menuStart + (menuTarget - menuStart) * t;
      if (this.currentCombat) this.currentCombat.volume = combatStart + (combatTarget - combatStart) * t;`,
`      if (this.menuEl) this.menuEl.volume = menuStart + (menuTarget - menuStart) * t;
      if (this.currentCombat) this.currentCombat.volume = combatStart + (combatTarget - combatStart) * t;
      if (this.briefingEl) this.briefingEl.volume = briefStart + (briefTarget - briefStart) * t;`,
 '简报淡入淡出');

rep(`        if (this.currentCombat && this.currentCombat.volume < 0.001 && !this.currentCombat.paused) this.currentCombat.pause();`,
`        if (this.currentCombat && this.currentCombat.volume < 0.001 && !this.currentCombat.paused) this.currentCombat.pause();
        if (this.briefingEl && this.briefingEl.volume < 0.001 && !this.briefingEl.paused) this.briefingEl.pause();`,
 '简报淡出停播');

rep(`    if (this.current === 'menu' && this.menuEl) this.menuEl.volume = this.targetVolume;
    if (this.current === 'combat' && this.currentCombat) this.currentCombat.volume = this.targetVolume;`,
`    if (this.current === 'menu' && this.menuEl) this.menuEl.volume = this.targetVolume;
    if (this.current === 'combat' && this.currentCombat) this.currentCombat.volume = this.targetVolume;
    if (this.current === 'briefing' && this.briefingEl) this.briefingEl.volume = this.targetVolume;`,
 'setVolume 含简报');

rep(`    this.menuEl?.pause();
    for (const el of this.combatEls) el.pause();`,
`    this.menuEl?.pause();
    this.briefingEl?.pause();
    this.storyCombatEl?.pause();
    for (const el of this.combatEls) el.pause();`,
 'dispose 停播');
console.log('§231a done');
