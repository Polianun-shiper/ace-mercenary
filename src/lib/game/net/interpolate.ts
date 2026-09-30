// ============================================================================
// 远端位姿插值器 (P2-2)
// ============================================================================
// 问题: 快照 20Hz 到达, 渲染 60~144Hz。直接把最新快照赋给远端飞机会看到
//   "一跳一跳"; 而且网络抖动会让到达间隔不均匀(有时 30ms 有时 80ms)。
//
// 标准解法(几乎所有 FPS/竞速/空战都用): **渲染延迟 + 双帧插值**
//   1. 缓冲每帧快照, 按发送端时间排序;
//   2. 渲染时间 = 本地时间 - INTERP_DELAY(默认 100ms);
//   3. 在缓冲里找夹住渲染时间的两帧, 线性/球面插值。
//   代价是远端画面比真实晚 ~100ms —— 这对"看到别人"完全可接受,
//   而且换来的是**完全平滑**的运动。
//
// 姿态用四元数 slerp(不是 lerp): 角度大时 lerp 会失真、还会在 180° 附近抖动。
//
// 外推(extrapolation): 缓冲被追平时(丢包/卡顿), 用最后一帧的速度做**有限外推**
//   (最多 200ms), 超过就冻结在最后已知位置 —— 宁可短暂停顿, 也不要"瞬移"。

import * as THREE from 'three';

/** 渲染延迟: 远端画面比真实晚这么久。越大越平滑、延迟越高。 */
export const INTERP_DELAY_MS = 100;
/** 缓冲上限(帧)。20Hz × 1s = 20 帧足够; 留余量到 40。 */
const MAX_BUFFER = 40;
/** 最多外推多久(ms), 超过则冻结。 */
const MAX_EXTRAP_MS = 200;

interface Sample {
  /** 发送端时间戳(ms) */
  t: number;
  /** 本地接收时刻(ms) —— 用于估算时钟偏移 */
  recvAt: number;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  vel: THREE.Vector3;
  hp: number;
  flags: number;
  team: number;
}

export interface InterpolatedPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  velocity: THREE.Vector3;
  hp: number;
  flags: number;
  team: number;
  /** 数据陈旧(缓冲空/长时间无包) —— 调用方可据此淡出或标记断线 */
  stale: boolean;
  /** 是否处于外推(缓冲被追平) */
  extrapolated: boolean;
}

/** 单个远端实体的插值缓冲。 */
class PeerTrack {
  private buf: Sample[] = [];
  /** 估算的"发送端时间 → 本地时间"偏移(ms), 用到达时刻平滑估计。 */
  private offset = 0;
  private haveOffset = false;
  lastRecvAt = 0;

  push(s: Sample): void {
    // 时钟偏移: 发送端时间戳与本地接收时刻的差。
    // 用 EMA 平滑(网络抖动会让单次估计跳变)。
    const inst = s.recvAt - s.t;
    if (!this.haveOffset) { this.offset = inst; this.haveOffset = true; }
    else this.offset += (inst - this.offset) * 0.15;

    // 乱序/重复包: 按时间插入
    if (this.buf.length && s.t <= this.buf[this.buf.length - 1].t) {
      const i = this.buf.findIndex((b) => b.t >= s.t);
      if (i >= 0 && this.buf[i].t === s.t) return;   // 重复, 丢弃
      this.buf.splice(i < 0 ? this.buf.length : i, 0, s);
    } else {
      this.buf.push(s);
    }
    while (this.buf.length > MAX_BUFFER) this.buf.shift();
    this.lastRecvAt = s.recvAt;
  }

  /** 采样渲染时刻对应的位姿。 */
  sample(nowMs: number, out: InterpolatedPose): boolean {
    if (!this.buf.length) {
      out.stale = true;
      return false;
    }
    // 渲染时间: 把"本地渲染时刻"换算到发送端时间轴, 再回退 INTERP_DELAY
    const renderT = (nowMs - this.offset) - INTERP_DELAY_MS;

    const first = this.buf[0];
    const last = this.buf[this.buf.length - 1];

    if (renderT <= first.t) {
      // 还没追上最早一帧 —— 直接用最早的(刚加入/刚收到第一包)
      applySample(first, out);
      out.stale = nowMs - this.lastRecvAt > 2000;
      out.extrapolated = false;
      return true;
    }
    if (renderT >= last.t) {
      // 缓冲被追平: 有限外推
      const dt = Math.min(renderT - last.t, MAX_EXTRAP_MS) / 1000;
      out.position.copy(last.pos).addScaledVector(last.vel, dt);
      out.quaternion.copy(last.quat);
      out.velocity.copy(last.vel);
      out.hp = last.hp; out.flags = last.flags; out.team = last.team;
      out.extrapolated = true;
      out.stale = nowMs - this.lastRecvAt > 2000;
      return true;
    }
    // 找夹住 renderT 的两帧
    let i = 0;
    for (let k = this.buf.length - 1; k >= 0; k--) {
      if (this.buf[k].t <= renderT) { i = k; break; }
    }
    const a = this.buf[i];
    const b = this.buf[Math.min(i + 1, this.buf.length - 1)];
    const span = b.t - a.t;
    const u = span > 0 ? (renderT - a.t) / span : 0;
    out.position.copy(a.pos).lerp(b.pos, u);
    out.quaternion.copy(a.quat).slerp(b.quat, u);
    out.velocity.copy(a.vel).lerp(b.vel, u);
    out.hp = u < 0.5 ? a.hp : b.hp;
    out.flags = u < 0.5 ? a.flags : b.flags;
    out.team = u < 0.5 ? a.team : b.team;
    out.stale = nowMs - this.lastRecvAt > 2000;
    out.extrapolated = false;
    return true;
  }

  get sampleCount(): number {
    return this.buf.length;
  }
}

function applySample(s: Sample, out: InterpolatedPose): void {
  out.position.copy(s.pos);
  out.quaternion.copy(s.quat);
  out.velocity.copy(s.vel);
  out.hp = s.hp; out.flags = s.flags; out.team = s.team;
}

/** 全部远端实体的插值管理。 */
export class RemoteInterpolator {
  private tracks = new Map<number, PeerTrack>();
  private reused: InterpolatedPose = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    hp: 0, flags: 0, team: 255, stale: true, extrapolated: false,
  };

  /** 收到一帧快照时调用(每帧可含多个实体)。 */
  ingest(
    poses: { entityHash: number; x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number; vx: number; vy: number; vz: number; hp: number; flags: number; team: number; t: number }[],
    recvAtMs: number,
  ): void {
    for (const p of poses) {
      let tr = this.tracks.get(p.entityHash);
      if (!tr) { tr = new PeerTrack(); this.tracks.set(p.entityHash, tr); }
      tr.push({
        t: p.t, recvAt: recvAtMs,
        pos: new THREE.Vector3(p.x, p.y, p.z),
        quat: new THREE.Quaternion(p.qx, p.qy, p.qz, p.qw),
        vel: new THREE.Vector3(p.vx, p.vy, p.vz),
        hp: p.hp, flags: p.flags, team: p.team,
      });
    }
  }

  /** 取某实体在 `nowMs` 时刻的插值位姿; 无数据返回 null。 */
  sample(entityHash: number, nowMs: number): InterpolatedPose | null {
    const tr = this.tracks.get(entityHash);
    if (!tr) return null;
    if (!tr.sample(nowMs, this.reused)) return null;
    // 返回副本 —— 调用方可能在同一帧内保存/比较
    return {
      position: this.reused.position.clone(),
      quaternion: this.reused.quaternion.clone(),
      velocity: this.reused.velocity.clone(),
      hp: this.reused.hp, flags: this.reused.flags, team: this.reused.team,
      stale: this.reused.stale, extrapolated: this.reused.extrapolated,
    };
  }

  /** 移除某实体(离开房间)。 */
  remove(entityHash: number): void {
    this.tracks.delete(entityHash);
  }

  clear(): void {
    this.tracks.clear();
  }

  /** 诊断: 每个 track 的缓冲帧数与最后接收时刻。 */
  debug(): { hash: number; frames: number; ageMs: number }[] {
    const now = Date.now();
    return [...this.tracks.entries()].map(([hash, tr]) => ({
      hash, frames: tr.sampleCount,
      ageMs: tr.lastRecvAt ? now - tr.lastRecvAt : -1,
    }));
  }
}
