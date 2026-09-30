// === 内建 FX 预设 (per user request: 那些没被 fx-tune 替换的特效, 自己替换/重置) ===
//
// 背景: 游戏的爆炸此前**一直是原生程序化**(public/config/fx-tune.json 只有 {"version":1},
// 没有任何槽位资产 ⇒ FxBattleLayer.init() 直接 disabled, 全部走原生)。用户要求把没替换的
// 特效补上 —— 可以"参考 fxeditor 里的", 也可以自己替换/重置。
//
// 这里走"自己写预设"的路: fx 资产的 schema 就是**发射器配置**(序列帧精灵/冲击波/闪光),
// 而 `sheet` 是**可选**的 —— 不传就用 FxSystem 里那张共享的"程序化柔边圆点"精灵。
// 于是: 零素材、零烘焙、零编辑器往返, 纯代码就能给游戏换一套爆炸观感。
//
// 观感配方(两档, 与原生爆炸的 air/ground 分类一致):
//   · 火球: additive 亮黄 → 橙红, 短寿命, 高速外扩 + 强阻力(先炸开再驻留);
//   · 烟:   normal 混合, 深灰褐 → 透明, 慢速上浮 + 膨胀, continuous 续发(留一团烟羽);
//   · 火星: additive, 小颗粒, 高速 + 重力(飞出去然后下坠);
//   · 冲击波: 一圈快速扩张的additive 环(空气爆炸更细更快, 地面爆炸更宽更慢);
//   · 闪光: 一次性 PointLight(照亮周围机体/地面) —— 原生爆炸最缺的就是这一下"照亮"。
//
// 优先级: 编辑器导出的 /config/fx-tune.json(或 localStorage) **优先** —— 有槽位就用它,
// 没有才回退到这里的内建预设(见 engine 的 FX 初始化段)。

import type { FxAsset, FxEmitterCfg } from './fx-core';
import type { FxTuneDoc } from '../game/fx-tune';

/** 爆炸预设的两档(与 FxBattleLayer 的槽位一致)。 */
export type BuiltinFxKind = 'air' | 'ground';

function fireball(kind: BuiltinFxKind): FxEmitterCfg {
  const air = kind === 'air';
  return {
    type: 'sprite', id: 'fire', name: '火球',
    mode: 'burst', burstCount: air ? 30 : 22, rate: 0,
    lifetime: air ? 0.62 : 0.5, lifetimeJitter: 0.4,
    speed: air ? 30 : 22, speedJitter: 0.65, spreadCone: 180,
    direction: [0, 1, 0], gravity: -7, drag: 3.4,
    size0: air ? 20 : 16, size1: air ? 52 : 42,
    color0: '#fff6d0', color1: air ? '#ff5410' : '#d9541a',
    opacity0: 1, opacity1: 0,
    blend: 'additive', spin: 1.7, spinJitter: 1,
  };
}

function smoke(kind: BuiltinFxKind): FxEmitterCfg {
  const air = kind === 'air';
  return {
    type: 'sprite', id: 'smoke', name: '烟团',
    mode: 'continuous', burstCount: 0,
    // 地面爆炸的扬尘更浓(rate 大、颜色偏土褐); 空中爆炸烟更少更黑。
    rate: air ? 26 : 64,
    lifetime: air ? 1.9 : 2.5, lifetimeJitter: 0.45,
    speed: air ? 9 : 12, speedJitter: 0.5, spreadCone: 90,
    direction: [0, 1, 0], gravity: -0.6, drag: 1.5,
    size0: air ? 16 : 20, size1: air ? 54 : 76,
    color0: air ? '#3a3a3c' : '#6b5a48', color1: '#2a2a2c',
    opacity0: air ? 0.55 : 0.6, opacity1: 0,
    blend: 'normal', spin: 0.5, spinJitter: 1,
  };
}

function sparks(kind: BuiltinFxKind): FxEmitterCfg {
  const air = kind === 'air';
  return {
    type: 'sprite', id: 'sparks', name: '火星',
    mode: 'burst', burstCount: air ? 26 : 18, rate: 0,
    lifetime: 0.75, lifetimeJitter: 0.5,
    speed: air ? 62 : 42, speedJitter: 0.7, spreadCone: 180,
    direction: [0, 1, 0], gravity: -26, drag: 0.8,
    size0: 2.6, size1: 0.8,
    color0: '#ffe9a8', color1: '#ff7a24',
    opacity0: 1, opacity1: 0,
    blend: 'additive', spin: 0, spinJitter: 0,
  };
}

function shockwave(kind: BuiltinFxKind): FxEmitterCfg {
  const air = kind === 'air';
  return {
    type: 'shockwave', id: 'wave', name: '冲击波',
    duration: air ? 0.34 : 0.55,
    startRadius: air ? 4 : 6, endRadius: air ? 78 : 104,
    thickness: air ? 2.4 : 3.6,
    color: air ? '#cfe6ff' : '#e8d8bc',
    opacity: 0.75, blend: 'additive',
  };
}

function flash(kind: BuiltinFxKind): FxEmitterCfg {
  const air = kind === 'air';
  return {
    type: 'lightflash', id: 'flash', name: '闪光',
    intensity: air ? 42 : 30, radius: air ? 320 : 240, decay: 2,
    duration: air ? 0.22 : 0.28,
    color: air ? '#ffd6a0' : '#ffbe86',
  };
}

/** 内建爆炸资产(无图集 ⇒ 用 FxSystem 的共享柔边精灵)。 */
export function builtinExplosionAsset(kind: BuiltinFxKind): FxAsset {
  return {
    version: 1,
    id: `__builtin_${kind}`,
    name: kind === 'air' ? '内建·空中爆炸' : '内建·地面爆炸',
    loop: false,
    slot: kind,
    emitters: [fireball(kind), smoke(kind), sparks(kind), shockwave(kind), flash(kind)],
  };
}

/**
 * 内建 fx-tune 文档: 两个槽位都指向内建资产。
 * engine 在"编辑器 JSON 没有槽位"时回退到它 —— 于是游戏默认就有这套爆炸,
 * 而在编辑里导出了 fx-tune.json 之后, 编辑器的那套会**覆盖**内建(优先级更高)。
 */
export function builtinFxTuneDoc(): FxTuneDoc {
  return {
    version: 1,
    slots: { ground: '__builtin_ground', air: '__builtin_air' },
    assets: [builtinExplosionAsset('ground'), builtinExplosionAsset('air')],
  };
}
