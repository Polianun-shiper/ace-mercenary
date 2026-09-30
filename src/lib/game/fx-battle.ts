// === FxBattleLayer:游戏爆炸替换层 (per user request: 编辑器的 sprite 特效
// === 替换游戏原本特效,发布时游戏脱离编辑器独立运行) ===
// 消费 fx-tune.json(含内嵌序列帧图集 dataURL):按槽位(地面 f / 空中 4)
// 取资产 → 预解码图集 → 注册。原生爆炸入口(weapons.onFxOverride)把每次
// 爆炸按「命中点离地高度」归类后交到这里:
//   - 命中 → FxSystem.play(asset, pos, scale 整体倍率)
//   - 预算(同时 ≤ MAX_PLAYS)/ 视距超限 → 吞掉本次(不播原生,不混跳)
//   - continuous 发射器(爆炸资产里的持续烟等)由内部持有表按 rate×dt 续发
// 无 fx-tune / 无槽位资产 / 解码失败 → 完全不影响游戏(原生爆炸照旧)。
import * as THREE from 'three';
import { FxSystem, sheetFootLift, type FxAsset, type SpriteEmitterCfg } from '../fx/fx-core';
import { slotAsset, type FxTuneDoc } from './fx-tune';
import { assetUrl } from './asset-url';

export type FxSlotKind = 'ground' | 'air';

/** 同时播放的新式爆炸上限(超过则吞掉本次,与原生 MAX_EXPLOSIONS 思路一致) */
const MAX_PLAYS = 10;
/** 视距上限(与 weapons.spawnExplosion 的 MAX_EFFECT_DIST 对齐) */
const MAX_FX_DIST = 14000;
/** 原生 scale(1≈基准)→ 预设整体倍率钳制范围 */
const MIN_SCALE = 0.4;
const MAX_SCALE = 5;

interface ActivePlay {
  asset: FxAsset;
  pos: THREE.Vector3;
  mul: number;
  t: number;
  dur: number;
  acc: Map<string, number>;
}

/** 资产总时长 = 所有发射器寿命上限(continuous 烟也要播完)。 */
function assetDuration(asset: FxAsset): number {
  let d = 0;
  for (const e of asset.emitters) {
    if (e.type === 'sprite') d = Math.max(d, e.lifetime);
    else if (e.type === 'shockwave') d = Math.max(d, e.duration);
    else d = Math.max(d, e.duration);
  }
  return Math.max(0.4, d + 0.4);
}

export class FxBattleLayer {
  private system: FxSystem;
  private groundAsset: FxAsset | null = null;
  private airAsset: FxAsset | null = null;
  private plays: ActivePlay[] = [];
  private lastCamPos = new THREE.Vector3();
  private _enabled = false;

  constructor(scene: THREE.Scene) {
    // 外置图集(Blender 烘的 <preset>-fire/smoke.png)走资产库解析: 单文件构建里
    // 它们的真实位置是 <out>/assets/textures/vfx/..., 直接丢给 TextureLoader 会 404。
    this.system = new FxSystem(scene, 2048, assetUrl);
  }

  /** 槽位资产是否已注册且图集解码完成。 */
  get enabled(): boolean { return this._enabled; }

  get activePlays(): number { return this.plays.length; }

  /** 按 fx-tune doc 注册两槽资产并预解码全部图集。 */
  async init(doc: FxTuneDoc | null): Promise<void> {
    this.groundAsset = slotAsset(doc, 'ground');
    this.airAsset = slotAsset(doc, 'air');
    const assets = [this.groundAsset, this.airAsset].filter((a): a is FxAsset => !!a);
    if (!assets.length) return; // 无槽位 → 保持 disabled,游戏原生照旧
    await this.system.prepareSheets(assets);
    this._enabled = true;
  }

  /**
   * 播放一次槽位爆炸。返回 true = 本次爆炸已被本层处理(替换/吞掉),
   * 调用方不应再播原生视觉;返回 false = 无此槽位资产,请走原生。
   */
  tryPlay(kind: FxSlotKind, pos: THREE.Vector3, scale: number): boolean {
    const asset = kind === 'ground' ? this.groundAsset : this.airAsset;
    if (!asset) return false;
    // 视距超限或预算满 → 吞掉(与原生 14km/24 个上限行为一致,不混跳原生)
    if (this.lastCamPos && pos.distanceToSquared(this.lastCamPos) > MAX_FX_DIST * MAX_FX_DIST) return true;
    if (this.plays.length >= MAX_PLAYS) return true;
    const mul = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    // 地面爆炸:图集主体"踩地"(quad 底边贴命中面,避免半截埋地)
    let playPos = pos;
    if (kind === 'ground') {
      const lift = sheetFootLift(asset, mul);
      if (lift > 0) {
        playPos = pos.clone();
        playPos.y += lift;
      }
    }
    this.system.play(asset, playPos, undefined, { scale: mul });
    this.plays.push({
      asset,
      pos: playPos.clone(),
      mul,
      t: 0,
      dur: assetDuration(asset),
      acc: new Map(),
    });
    return true;
  }

  /** 每帧驱动(须在原生武器更新之后调用;camera 用于 billboard 与视距)。 */
  update(dt: number, camera: THREE.PerspectiveCamera) {
    if (!this._enabled && !this.plays.length) return;
    this.lastCamPos.copy(camera.position);
    this.system.update(dt, camera);
    // 续发 continuous 发射器(每播放条目独立按 rate 产粒子)
    for (let i = this.plays.length - 1; i >= 0; i--) {
      const p = this.plays[i];
      p.t += dt;
      if (p.t >= p.dur) { this.plays.splice(i, 1); continue; }
      for (const e of p.asset.emitters) {
        if (e.type !== 'sprite' || e.mode !== 'continuous') continue;
        const acc = (p.acc.get(e.id) ?? 0) + (e as SpriteEmitterCfg).rate * dt;
        let n = Math.floor(acc);
        p.acc.set(e.id, acc - n);
        while (n-- > 0) this.system.playEmitter(e, p.pos, undefined, { scale: p.mul });
      }
    }
  }

  dispose() {
    this.system.dispose();
    this.plays.length = 0;
    this.groundAsset = null;
    this.airAsset = null;
    this._enabled = false;
  }
}
