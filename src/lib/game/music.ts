// Music + SFX player.
//
// === Tracks ===
// Menu/hangar/briefing: music_hangar.mp3 (Fort Grays Air Base Hangar —
//   calm airbase ambiance for the pre-mission screens).
// Combat: one of three long battle tracks, chosen randomly per mission:
//   - music_alect.mp3     (Alect Squadron, Armada, Operation X)
//   - music_gaiuss.mp3    (Gaiuss Tower, Wild Card)
//   - music_last_line.mp3 (Last Line of Defense, False Target, Break In)
//
// === File-based SFX ===
// We layer real recorded SFX on top of the procedural AudioEngine:
//   - afterburner.mp3            — looping, volume tracks throttle above 95%
//   - sfx_explosion_large.mp3    — large airburst / ship kill
//   - sfx_bomb_drop.mp3          — bomb drop + ground explosion
//   - sfx_explosion_destroy.mp3  — generic unit-kill explosion (通用爆炸击毁声)
//   - sfx_explosion2.mp3         — secondary explosion (爆炸声2) — used for
//                                  sonic booms and missile detonations
//   - sfx_missile_launch.mp3     — missile launch (when available)
//   - sfx_missile_rack.mp3       — missile rack drop-off sound (pre-launch)
//
// File SFX are routed through their own gain node so they can be muted
// independently from music.

import { assetUrl } from './asset-url';

export type TrackName = 'menu' | 'combat' | 'briefing' | 'none';   // briefing: 3D 简报界面专属曲

// Map a map-type + sky-preset to a combat music filename.
// The choice is randomized per mission start so the same map doesn't
// always play the same track.
const COMBAT_TRACKS = [
  '/audio/music_alect.mp3',
  '/audio/music_gaiuss.mp3',
  '/audio/music_last_line.mp3',
] as const;

const BRIEFING_TRACK = assetUrl('/audio/music_briefing.mp3');

// === 第二关《洞川撤退》阶段音乐 (per user request: 就两条曲子, loop 循环) =========
const S02_STAGE_TRACK = assetUrl('/audio/music_s02_pipeline.mp3');   // 阶段 1-3
const S02_FINAL_TRACK = assetUrl('/audio/music_s02_three_kind.mp3'); // 阶段 4

export class MusicPlayer {
  private menuEl: HTMLAudioElement | null = null;
  private briefingEl: HTMLAudioElement | null = null;
  private storyCombat = false;
  private sfxWeaponSwitchEl: HTMLAudioElement | null = null;
  private sfxShuttleRumbleEl: HTMLAudioElement | null = null;
  private sfxAirburstEl: HTMLAudioElement | null = null;   // 空爆弹引爆(用户录音)
  private s02El: HTMLAudioElement | null = null;
  private s02Url = '';
  private s02OwnsMusic = false;
  private combatEls: HTMLAudioElement[] = [];
  private currentCombat: HTMLAudioElement | null = null;
  private afterburnerEl: HTMLAudioElement | null = null;
  // Cached one-shot SFX elements (cloned on play for overlap).
  private sfxExplosionEl: HTMLAudioElement | null = null;
  private sfxBomberEl: HTMLAudioElement | null = null;
  // === New file-based SFX (per user request) ===
  // Pre-loaded source elements. Each play() clones the element so
  // overlapping detonations don't cut each other off.
  private sfxExplosionDestroyEl: HTMLAudioElement | null = null; // 通用爆炸击毁声
  private sfxExplosion2El: HTMLAudioElement | null = null;       // 爆炸声2 (sonic boom / missile det)
  private sfxMissileLaunchEl: HTMLAudioElement | null = null;    // 导弹发射
  private sfxMissileRackEl: HTMLAudioElement | null = null;      // 离架声
  private current: TrackName = 'none';
  private targetVolume = 0.55;
  private sfxVolume = 0.7;
  private afterburnerVolume = 0.0;
  private fadeRaf = 0;
  private started = false;
  private afterburnerStarted = false;

  init() {
    if (this.started) return;
    this.started = true;
    this.sfxWeaponSwitchEl = new Audio(assetUrl('/audio/sfx_weapon_switch.wav'));
    this.sfxWeaponSwitchEl.preload = 'auto';
    this.sfxShuttleRumbleEl = new Audio(assetUrl('/audio/sfx_shuttle_rumble.mp3'));
    this.sfxShuttleRumbleEl.preload = 'auto';
    this.sfxAirburstEl = new Audio(assetUrl('/audio/sfx_airburst.wav'));
    this.sfxAirburstEl.preload = 'auto';
    this.menuEl = new Audio('/audio/music_hangar.mp3');
    this.menuEl.loop = true;
    this.menuEl.preload = 'auto';
    this.menuEl.volume = 0;
    for (const url of COMBAT_TRACKS) {
      const el = new Audio(url);
      el.loop = true;
      el.preload = 'auto';
      el.volume = 0;
      this.combatEls.push(el);
    }
    // Afterburner — loop, starts at zero volume.
    this.afterburnerEl = new Audio('/audio/afterburner.mp3');
    this.afterburnerEl.loop = true;
    this.afterburnerEl.preload = 'auto';
    this.afterburnerEl.volume = 0;
    // SFX — preloaded, cloned on play.
    this.sfxExplosionEl = new Audio('/audio/sfx_explosion_large.mp3');
    this.sfxExplosionEl.preload = 'auto';
    this.sfxBomberEl = new Audio('/audio/sfx_bomb_drop.mp3');
    this.sfxBomberEl.preload = 'auto';
    // === New SFX files (per user request) ===
    // 通用爆炸击毁声 — used when a unit dies (aircraft/ground kill).
    this.sfxExplosionDestroyEl = new Audio('/audio/sfx_explosion_destroy.mp3');
    this.sfxExplosionDestroyEl.preload = 'auto';
    // 爆炸声2 — used for sonic booms and missile detonations.
    this.sfxExplosion2El = new Audio('/audio/sfx_explosion2.mp3');
    this.sfxExplosion2El.preload = 'auto';
    // 导弹发射 / 离架声 — best-effort load (files may be placeholders).
    this.sfxMissileLaunchEl = new Audio('/audio/sfx_missile_launch.mp3');
    this.sfxMissileLaunchEl.preload = 'auto';
    this.sfxMissileRackEl = new Audio('/audio/sfx_missile_rack.mp3');
    this.sfxMissileRackEl.preload = 'auto';
  }

  /** Resume audio — call on user gesture (browser autoplay policy). */
  async resume() {
    if (!this.started) this.init();
    // Play all tracks silently so they're "started" — browser policy
    // requires play() to be called from a user gesture, but once playing
    // we can fade volume up/down freely.
    const all: HTMLAudioElement[] = [];
    if (this.menuEl) all.push(this.menuEl);
    if (this.briefingEl) all.push(this.briefingEl);
    all.push(...this.combatEls);
    if (this.afterburnerEl) all.push(this.afterburnerEl);
    for (const el of all) {
      try {
        if (el.paused) await el.play().catch(() => { /* will retry */ });
      } catch { /* ignore */ }
    }
  }

  /** Pick a random combat track for the upcoming mission. */
  pickCombatTrack() {
    const idx = Math.floor(Math.random() * this.combatEls.length);
    this.currentCombat = this.combatEls[idx] ?? null;
  }

  setTrack(track: TrackName, fadeMs = 1500) {
    if (!this.started) this.init();
    if (this.current === track && (track !== 'combat' || this.currentCombat)) return;
    this.current = track;
    if (track === 'combat' && !this.currentCombat) this.pickCombatTrack();
    cancelAnimationFrame(this.fadeRaf);
    const start = performance.now();
    const menuStart = this.menuEl?.volume ?? 0;
    const combatStart = this.currentCombat?.volume ?? 0;
    if (track !== 'combat') { this.stopS02(); this.s02OwnsMusic = false; }
    if (track === 'combat' && this.s02OwnsMusic) { this.current = 'combat'; return; }
    const briefStart = this.briefingEl?.volume ?? 0;
    const briefTarget = track === 'briefing' ? this.targetVolume : 0;
    const menuTarget = track === 'menu' ? this.targetVolume : 0;
    const combatTarget = track === 'combat' ? this.targetVolume : 0;
    // Ensure correct elements are playing
    if (track === 'menu' && this.menuEl) {
      this.menuEl.play().catch(() => {});
    }
    if (track === 'briefing' && this.briefingEl) {
      this.briefingEl.play().catch(() => {});
    }
    if (track === 'combat' && this.currentCombat) {
      this.currentCombat.play().catch(() => {});
    }
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / fadeMs);
      if (this.menuEl) this.menuEl.volume = menuStart + (menuTarget - menuStart) * t;
      if (this.currentCombat) this.currentCombat.volume = combatStart + (combatTarget - combatStart) * t;
      if (this.briefingEl) this.briefingEl.volume = briefStart + (briefTarget - briefStart) * t;
      // Pause silent tracks after fade-out completes
      if (t >= 1) {
        if (this.menuEl && this.menuEl.volume < 0.001 && !this.menuEl.paused) this.menuEl.pause();
        if (this.currentCombat && this.currentCombat.volume < 0.001 && !this.currentCombat.paused) this.currentCombat.pause();
        return;
      }
      this.fadeRaf = requestAnimationFrame(step);
    };
    step();
  }

  setVolume(v: number) {
    this.targetVolume = Math.max(0, Math.min(1, v));
    if (this.current === 'menu' && this.menuEl) this.menuEl.volume = this.targetVolume;
    if (this.current === 'combat' && this.currentCombat) this.currentCombat.volume = this.targetVolume;
  }

  /** Set afterburner roar volume (0..1). Tracks throttle. */
  setAfterburner(v: number) {
    if (!this.started || !this.afterburnerEl) return;
    this.afterburnerVolume = Math.max(0, Math.min(1, v));
    // Start the afterburner loop on first non-zero call.
    if (this.afterburnerVolume > 0.01 && !this.afterburnerStarted) {
      this.afterburnerEl.play().catch(() => {});
      this.afterburnerStarted = true;
    }
    this.afterburnerEl.volume = this.afterburnerVolume * 0.6;
  }

  /** Play a one-shot SFX. Type selects which file. */
  playSfx(type: 'explosion_large' | 'bomb_drop' | 'explosion_destroy' | 'explosion2' | 'missile_launch' | 'missile_rack' | 'weapon_switch' | 'shuttle_rumble' | 'airburst'): void {
    if (!this.started) return;
    let src: HTMLAudioElement | null = null;
    if (type === 'explosion_large') src = this.sfxExplosionEl;
    else if (type === 'bomb_drop') src = this.sfxBomberEl;
    else if (type === 'explosion_destroy') src = this.sfxExplosionDestroyEl;
    else if (type === 'explosion2') src = this.sfxExplosion2El;
    else if (type === 'missile_launch') src = this.sfxMissileLaunchEl;
    else if (type === 'missile_rack') src = this.sfxMissileRackEl;
    else if (type === 'weapon_switch') src = this.sfxWeaponSwitchEl;
    else if (type === 'airburst') src = this.sfxAirburstEl;
    if (!src) return;
    // === Skip if the source file failed to load (placeholder/corrupt upload) ===
    // We detect this by checking readyState — if it's HAVE_NOTHING (0) after
    // the browser has had time to load, the file is missing/corrupt and
    // cloning it would just produce silence + a console error.
    if (src.readyState === 0) {
      // Try to reload once (in case it was a network race)
      try { src.load(); } catch { /* ignore */ }
      return;
    }
    // Clone for overlapping playback
    const clone = src.cloneNode() as HTMLAudioElement;
    // === Volume curve per SFX type (per user request — 爆炸声2 + 通用爆炸击毁声 are the new stars) ===
    let vol = this.sfxVolume;
    if (type === 'explosion_destroy') vol = this.sfxVolume * 1.0;  // full volume — unit kill
    else if (type === 'explosion2') vol = this.sfxVolume * 0.85;   // slightly quieter for sonic boom / missile det
    else if (type === 'missile_launch') vol = this.sfxVolume * 0.7;
    else if (type === 'missile_rack') vol = this.sfxVolume * 0.55;
    clone.volume = Math.max(0, Math.min(1, vol));
    clone.play().catch(() => { /* ignore autoplay errors */ });
    // Auto-cleanup after 4s (give longer explosions time to finish)
    setTimeout(() => { clone.pause(); clone.src = ''; }, 4000);
  }

  stop(fadeMs = 800) {
    if (!this.started) return;
    const start = performance.now();
    const menuStart = this.menuEl?.volume ?? 0;
    const combatStart = this.currentCombat?.volume ?? 0;
    cancelAnimationFrame(this.fadeRaf);
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / fadeMs);
      if (this.menuEl) this.menuEl.volume = menuStart * (1 - t);
      if (this.currentCombat) this.currentCombat.volume = combatStart * (1 - t);
      if (t >= 1) {
        this.menuEl?.pause();
        this.currentCombat?.pause();
        this.current = 'none';
        return;
      }
      this.fadeRaf = requestAnimationFrame(step);
    };
    step();
  }

  dispose() {
    cancelAnimationFrame(this.fadeRaf);
    this.menuEl?.pause();
    for (const el of this.combatEls) el.pause();
    this.afterburnerEl?.pause();
    this.menuEl = null;
    this.combatEls = [];
    this.currentCombat = null;
    this.afterburnerEl = null;
    this.sfxExplosionEl = null;
    this.sfxBomberEl = null;
    this.sfxExplosionDestroyEl = null;
    this.sfxExplosion2El = null;
    this.sfxMissileLaunchEl = null;
    this.sfxMissileRackEl = null;
    this.started = false;
    this.afterburnerStarted = false;
    this.current = 'none';
  }

  /** 这一关是不是用剧情专属战斗曲(引擎在 startMission 里调)。 */
  useStoryCombat(on: boolean) { this.storyCombat = on; this.current = 'none'; }

  /** 引擎用: 是否第二关(第二关不用 White Bird, 由阶段音乐接管)。 */
  setS02Mode(on: boolean) {
    if (on) {
      for (const el of this.combatEls) { if (!el.paused) el.pause(); el.volume = 0; }
      this.currentCombat = null;
      this.s02OwnsMusic = true;
      // ⚠ 菜单曲/简报曲也要收掉: 第二关跳过了 setTrack('combat'), 而淡出菜单曲原本是那条路
      //   顺带做的事 ⇒ 不收的话菜单音乐一路响进关卡(实测用户马上听出来)。
      if (this.menuEl && !this.menuEl.paused) { this.menuEl.pause(); this.menuEl.volume = 0; }
      if (this.briefingEl && !this.briefingEl.paused) { this.briefingEl.pause(); this.briefingEl.volume = 0; }
      this.current = 'none';
    }
  }

  /** === 第二关阶段音乐: 就两条曲子, loop 循环 (简化版, per user request) ==========
   *  阶段 1-3 = Pipeline Destruction; 阶段 4 = Three of a Kind。 */
  setS02StageMusic(stage: number) {
    if (!this.started) this.init();
    this.setS02Mode(true);
    const url = stage >= 3 ? S02_FINAL_TRACK : S02_STAGE_TRACK;
    if (this.s02Url === url && this.s02El && !this.s02El.paused) return;   // 同一首不重启
    if (this.s02El) { this.s02El.pause(); this.s02El = null; }
    this.s02Url = url;
    const el = new Audio(url);
    el.loop = true;                  // ← 就这一句: 两条曲子各自循环
    el.preload = 'auto';
    el.volume = this.targetVolume;
    el.play().catch(() => { /* 自动播放策略: 首次交互后会被再次调到 */ });
    this.s02El = el;
  }

  stopS02() { this.s02El?.pause(); this.s02El = null; this.s02Url = ''; }

  setSfxVolume(v: number) { this.sfxVolume = Math.max(0, Math.min(1, v)); }

  /** Play a one-shot SFX. */
  playShuttleRumble(seconds = 6): void {
    if (!this.started) return;
    const src = this.sfxShuttleRumbleEl;
    if (!src) return;
    if (src.readyState === 0) { try { src.load(); } catch { /* ignore */ } return; }
    const clone = src.cloneNode() as HTMLAudioElement;
    clone.volume = Math.max(0, Math.min(1, this.sfxVolume * 0.9));
    clone.currentTime = 0;
    clone.play().catch(() => { /* ignore */ });
    window.setTimeout(() => { clone.pause(); clone.src = ''; }, Math.max(1000, seconds * 1000));
  }

  getCurrent(): TrackName { return this.current; }
}

// Singleton instance — shared across menus and game engine.
let _musicPlayer: MusicPlayer | null = null;
export function getMusicPlayer(): MusicPlayer {
  if (!_musicPlayer) _musicPlayer = new MusicPlayer();
  return _musicPlayer;
}
