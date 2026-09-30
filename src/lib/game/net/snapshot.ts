// ============================================================================
// 玩家位姿快照协议 (P2-1)
// ============================================================================
// 规范要求(红线):
//   · 实时状态走 P2P(room.sendRealtime), 禁止写库、禁止轮询
//   · 快照 15~20Hz; 输入上行 ≤30Hz
//   · "状态可丢、事件不可丢" —— 位置/姿态用可丢通道, 击毁/命中用可靠通道
//   · 单条消息编码后 ≤ 65535 bytes
//
// 为什么用**二进制**而不是 JSON:
//   8 人对局 × 20Hz: JSON 一条约 200~300 字节, 二进制只 44 字节 ——
//   省 5 倍以上带宽。规范也明确建议"如有大的游戏状态用 Binary 传"。
//
// 布局(小端, 44 字节/人):
//   u16  entityIdHash   实体标识(见下方 hash 说明)
//   f32  px, py, pz     位置(世界坐标)
//   i16  qx, qy, qz, qw 姿态四元数(归一化到 int16)
//   i16  vx, vy, vz     速度(单位: 0.5 m/s per LSB, 上限 ±16383 → ±8191 m/s)
//   u16  hp             血量(0..65535)
//   u8   flags          bit0 存活 / bit1 加力 / bit2 开火 / bit3 减速板
//   u8   team           队伍 slot(0/1, 255 = FFA 未分)
//   = 2 + 12 + 8 + 6 + 2 + 1 + 1 = 32 字节
//
// **entityIdHash**: 用 u16 而不是整串 peerId —— peerId 是变长字符串, 每帧重复
// 发送会浪费带宽。做法: 加入房间时通过**可靠通道**交换一次 peerId↔hash 映射,
// 之后快照只带 hash。hash 冲突概率在 ≤8 人时极低(u16 空间 65536),
// 且握手期会校验, 冲突则重新分配(见 hashOfPeer)。

/** 快照 flag 位。 */
export const SNAP_ALIVE = 1 << 0;
export const SNAP_AFTERBURNER = 1 << 1;
export const SNAP_FIRING = 1 << 2;
export const SNAP_AIRBRAKE = 1 << 3;
export const SNAP_DEAD = 1 << 4;

/** 单条记录字节数。 */
export const SNAP_RECORD_BYTES = 32;
/** 单包最大记录数(保持远小于 65535, 给多玩家合并留余量)。 */
export const SNAP_MAX_RECORDS = 32;

export interface PoseSnapshot {
  /** 稳定的实体 hash(见 hashOfPeer)。 */
  entityHash: number;
  x: number; y: number; z: number;
  /** 姿态四元数(已归一化)。 */
  qx: number; qy: number; qz: number; qw: number;
  /** 速度(m/s)。 */
  vx: number; vy: number; vz: number;
  hp: number;
  flags: number;
  /** 队伍 slot(0/1; 255 = 未分队/FFA)。 */
  team: number;
  /** 发送端的时间戳(ms, 用于插值时间轴对齐)。 */
  t: number;
}

/**
 * peerId → u16 hash。
 *
 * 用 FNV-1a 变体, 确定性(同一 peerId 在任何客户端得到同一 hash), 不需要中心分配。
 * 冲突在 ≤8 人时概率约 8²/(2×65536) ≈ 0.05%, 且加入时会用可靠通道交换映射,
 * 发现冲突可换 salt 重算(见 resolveHashCollision)。
 */
export function hashOfPeer(peerId: string, salt = 0): number {
  let h = 0x811c9dc5 ^ (salt & 0xffff);
  for (let i = 0; i < peerId.length; i++) {
    h ^= peerId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // 避开保留值 0(0 表示"未知"); **清掉最高位** —— 高位置 1 的取值空间留给任务 AI
  // (见 aiHash), 这样接收端不看表也能分辨"这条记录是玩家/僚机还是 AI"。
  const v = ((h >>> 16) ^ h) & 0x7fff;
  return v === 0 ? 1 : v;
}

/** 最高位 = 任务 AI 记录标志(与玩家/僚机 hash 空间结构性分离)。 */
export const AI_HASH_FLAG = 0x8000;

/** 这条记录是不是任务 AI(P5)。 */
export function isAiHash(h: number): boolean {
  return (h & AI_HASH_FLAG) !== 0;
}

/**
 * 中队僚机(玩家自带的 wingman)的实体 hash。
 *
 * "每个玩家自带一个中队僚机"(P3)意味着**每个客户端只仿真自己拥有的单位**,
 * 包括自己的僚机 —— 所以僚机位姿要和玩家位姿同包广播(见 session.maybeSend)。
 * 为了让对端能把 hash 还原成"谁的僚机", 这里用**拥有者 hash + 槽位**做确定性
 * 推导: 对端在 who 握手里拿到 ownerHash 与 squad 规模后即可算出同样的 hash,
 * 不需要在快照协议里新增字段(仍然 32 字节/单位, 省带宽)。
 *
 * @param ownerHash 拥有者(玩家)的实体 hash
 * @param slot      僚机槽位(从 1 开始)
 */
export function sqHash(ownerHash: number, slot: number): number {
  return hashOfPeer(`sq:${ownerHash & 0xffff}:${slot}`);
}

/**
 * 任务 AI 单位的实体 hash (P5)。
 *
 * 任务 AI 的 id 在两端是**确定性一致**的(同一任务脚本、同一生成顺序), 所以只要把
 * 数字 id 映射成 u16 hash, 就能与玩家/僚机**共用同一条快照通道** —— 协议不用改。
 * 用独立 salt, 避免与 peerId / sqHash 的取值空间撞车。
 */
export function aiHash(aiId: number): number {
  return AI_HASH_FLAG | (hashOfPeer(`ai:${aiId}`, 0x5a5a) & 0x7fff);
}

/** 量化辅助: 把 -1..1 映射到 int16。 */
const q15 = (v: number): number => Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
const dq15 = (v: number): number => v / 32767;
/** 速度量化: 0.5 m/s per LSB。 */
const V_SCALE = 2;
const vq = (v: number): number => Math.max(-32767, Math.min(32767, Math.round(v * V_SCALE)));
const dvq = (v: number): number => v / V_SCALE;

/**
 * 编码一帧(可含多个玩家记录)。
 *
 * 返回 ArrayBuffer 供 `room.sendRealtime()` 直接发送 ——
 * 规范明确支持 ArrayBuffer, 且 SDK 会原样投递(不 parse JSON)。
 */
export function encodePoses(poses: PoseSnapshot[]): ArrayBuffer {
  const n = Math.min(poses.length, SNAP_MAX_RECORDS);
  const buf = new ArrayBuffer(4 + n * SNAP_RECORD_BYTES);
  const dv = new DataView(buf);
  // 头: u8 版本 + u8 记录数 + u16 保留(后续可用于序号)
  dv.setUint8(0, 1);
  dv.setUint8(1, n);
  dv.setUint16(2, 0);
  let off = 4;
  for (let i = 0; i < n; i++) {
    const p = poses[i];
    dv.setUint16(off, p.entityHash & 0xffff); off += 2;
    dv.setFloat32(off, p.x, true); off += 4;
    dv.setFloat32(off, p.y, true); off += 4;
    dv.setFloat32(off, p.z, true); off += 4;
    dv.setInt16(off, q15(p.qx), true); off += 2;
    dv.setInt16(off, q15(p.qy), true); off += 2;
    dv.setInt16(off, q15(p.qz), true); off += 2;
    dv.setInt16(off, q15(p.qw), true); off += 2;
    dv.setInt16(off, vq(p.vx), true); off += 2;
    dv.setInt16(off, vq(p.vy), true); off += 2;
    dv.setInt16(off, vq(p.vz), true); off += 2;
    dv.setUint16(off, Math.max(0, Math.min(65535, Math.round(p.hp))), true); off += 2;
    dv.setUint8(off, p.flags & 0xff); off += 1;
    dv.setUint8(off, p.team & 0xff); off += 1;
  }
  return buf;
}

/**
 * 解码。传入 `recvAtMs`(本地收到时刻)用于插值时间轴。
 * 返回空数组表示包无效/版本不符(向前兼容: 丢弃而不是抛错)。
 */
export function decodePoses(buf: ArrayBuffer, recvAtMs: number): PoseSnapshot[] {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 4) return [];
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== 1) return [];
  const n = Math.min(dv.getUint8(1), SNAP_MAX_RECORDS);
  if (buf.byteLength < 4 + n * SNAP_RECORD_BYTES) return [];
  const out: PoseSnapshot[] = [];
  let off = 4;
  for (let i = 0; i < n; i++) {
    const entityHash = dv.getUint16(off); off += 2;
    const x = dv.getFloat32(off, true); off += 4;
    const y = dv.getFloat32(off, true); off += 4;
    const z = dv.getFloat32(off, true); off += 4;
    const qx = dq15(dv.getInt16(off, true)); off += 2;
    const qy = dq15(dv.getInt16(off, true)); off += 2;
    const qz = dq15(dv.getInt16(off, true)); off += 2;
    const qw = dq15(dv.getInt16(off, true)); off += 2;
    const vx = dvq(dv.getInt16(off, true)); off += 2;
    const vy = dvq(dv.getInt16(off, true)); off += 2;
    const vz = dvq(dv.getInt16(off, true)); off += 2;
    const hp = dv.getUint16(off, true); off += 2;
    const flags = dv.getUint8(off); off += 1;
    const team = dv.getUint8(off); off += 1;
    // 归一化四元数(量化误差可能让它略微非单位)
    const len = Math.hypot(qx, qy, qz, qw) || 1;
    out.push({
      entityHash, x, y, z,
      qx: qx / len, qy: qy / len, qz: qz / len, qw: qw / len,
      vx, vy, vz, hp, flags, team, t: recvAtMs,
    });
  }
  return out;
}

/** 一帧位姿的字节数(诊断用)。 */
export function poseBytes(count: number): number {
  return 4 + Math.min(count, SNAP_MAX_RECORDS) * SNAP_RECORD_BYTES;
}
