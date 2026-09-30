'use client';

import { useEffect, useRef } from 'react';

interface Blip {
  x: number;
  y: number;
  type: 'enemy' | 'ally' | 'neutral' | 'missile';
  id: number;
  /** === 重要单位(友军轰炸机群等): 雷达上额外打一个 X (per user request) === */
  important?: boolean;
}

interface OffRadarBlip extends Blip {
  dist: number;
}

interface MinimapBlip {
  x: number; // world X
  z: number; // world Z
  y: number; // altitude
  type: 'enemy' | 'ally' | 'neutral' | 'missile';
  id: number;
  isTarget?: boolean;
  /** 重要单位(友军轰炸机群) ⇒ 打 X */
  important?: boolean;
}

interface RadarProps {
  blips: Blip[];
  offRadar: OffRadarBlip[];
  heading: number;
  targetId?: number;
}

export function Radar({ blips, offRadar, heading, targetId }: RadarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const W = c.width;
    const H = c.height;
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H) / 2 - 2;

    // === Background circle ===
    ctx.fillStyle = 'rgba(20,12,0,0.66)';
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();

    // === Outer bezel frame ===
    ctx.strokeStyle = 'rgba(255,176,0,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    // Tick marks every 30°
    ctx.strokeStyle = 'rgba(255,176,0,0.55)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
      const r1 = R - 4;
      const r2 = R - (i % 3 === 0 ? 9 : 6);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      ctx.stroke();
    }

    // === Range rings ===
    ctx.strokeStyle = 'rgba(255,176,0,0.30)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, (R * i) / 3, 0, Math.PI * 2);
      ctx.stroke();
    }

    // === Crosshair (rotates with heading) ===
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-heading * Math.PI / 180);
    ctx.strokeStyle = 'rgba(255,176,0,0.45)';
    ctx.beginPath();
    ctx.moveTo(-R, 0); ctx.lineTo(R, 0);
    ctx.moveTo(0, -R); ctx.lineTo(0, R);
    ctx.stroke();
    // Range numbers
    ctx.fillStyle = 'rgba(255,209,122,0.75)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('6K', 0, -R + 12);
    ctx.fillText('3K', 0, -R / 3 + 4);
    ctx.restore();

    // === Sweep ===
    const sweep = (performance.now() / 1500) % (Math.PI * 2);
    const grad = ctx.createConicGradient ? ctx.createConicGradient(sweep, cx, cy) : null;
    if (grad) {
      grad.addColorStop(0, 'rgba(255,176,0,0.0)');
      grad.addColorStop(0.05, 'rgba(255,176,0,0.45)');
      grad.addColorStop(0.15, 'rgba(255,176,0,0.0)');
      grad.addColorStop(1, 'rgba(255,176,0,0.0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, R - 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // === Clip to circle ===
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R - 1, 0, Math.PI * 2);
    ctx.clip();

    // === Blips — rotated by -heading so player's nose always points up ===
    const rot = -heading * Math.PI / 180;
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);
    const drawBlip = (b: Blip, isTarget = false, size = 4) => {
      // Rotate the (x,y) so the player's forward (+y) stays up
      const rx = b.x * cosR - b.y * sinR;
      const ry = b.x * sinR + b.y * cosR;
      const px = cx + rx * R;
      const py = cy - ry * R;

      let color = '#ff3b1f';
      if (b.type === 'ally') color = '#5ad2ff';
      else if (b.type === 'neutral') color = '#ffffff';  // === Per user request: white for neutral units ===
      else if (b.type === 'missile') color = '#ffd27a';

      if (isTarget) {
        // === Selected-target highlight (per user request: 雷达高亮选中目标) ===
        // Pulsing gold ring + gold corner brackets so the switched target
        // pops out from every other blip on the radar.
        const pulse = 0.6 + Math.sin(performance.now() / 180) * 0.4;
        ctx.strokeStyle = `rgba(255,215,80,${pulse})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, size + 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = '#ffb000';
        ctx.lineWidth = 1.6;
        const s = size + 4;
        // Corner brackets
        const corners = [
          [-s, -s, 1, 0, 0, 1], [-s, -s, 0, 1, 1, 0],
          [s, -s, -1, 0, 0, 1], [s, -s, 0, 1, -1, 0],
          [-s, s, 1, 0, 0, -1], [-s, s, 0, -1, 1, 0],
          [s, s, -1, 0, 0, -1], [s, s, 0, -1, -1, 0],
        ];
        for (const [ox, oy, dx, dy, ex, ey] of corners) {
          ctx.beginPath();
          ctx.moveTo(px + ox, py + oy);
          ctx.lineTo(px + ox + dx * 4 + ex * 4, py + oy + dy * 4 + ey * 4);
          ctx.stroke();
        }
      }

      if (b.type === 'enemy') {
        ctx.fillStyle = color;
        ctx.fillRect(px - size / 2, py - size / 2, size, size);
      } else if (b.type === 'ally') {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px, py, size * 0.7, 0, Math.PI * 2);
        ctx.fill();
      } else if (b.type === 'neutral') {
        // === Neutral: diamond shape (per user request) ===
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(px, py - size);
        ctx.lineTo(px + size, py);
        ctx.lineTo(px, py + size);
        ctx.lineTo(px - size, py);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px, py, size * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // === 重要单位(友军轰炸机群等): 在标记上再打一个 **X** (per user request) ======
      // 用同一个 color(友军=青), 线宽 1.8, 两条对角线穿住标记 ⇒ 一眼能认出"这帮是重点保护对象"
      if (b.important) {
        // 重要单位要"相当显眼": 外圈加一圈实线 + 粗 X(线宽 2.4)
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(px, py, size + 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.4;
        const sx = size + 3.5;
        ctx.beginPath();
        ctx.moveTo(px - sx, py - sx);
        ctx.lineTo(px + sx, py + sx);
        ctx.moveTo(px + sx, py - sx);
        ctx.lineTo(px - sx, py + sx);
        ctx.stroke();
      }
    };

    for (const b of blips) {
      const isTgt = targetId !== undefined && b.id === targetId;
      // 重要单位画大一号(+2), 敌机 5 / 其余 4
      drawBlip(b, isTgt, (b.type === 'enemy' ? 5 : 4) + (b.important ? 2 : 0));
    }

    ctx.restore(); // remove clip

    // === Off-radar arrows on the ring edge ===
    for (const b of offRadar) {
      const rx = b.x * cosR - b.y * sinR;
      const ry = b.x * sinR + b.y * cosR;
      const len = Math.sqrt(rx * rx + ry * ry) || 1;
      const ex = cx + (rx / len) * (R - 8);
      const ey = cy - (ry / len) * (R - 8);
      const angle = Math.atan2(-ry, rx);
      let color = '#ff3b1f';
      if (b.type === 'ally') color = '#5ad2ff';
      else if (b.type === 'neutral') color = '#ffffff';
      else if (b.type === 'missile') color = '#ffd27a';
      // === Selected target arrow highlight (per user request) ===
      // The currently switched target's direction arrow is drawn big, gold,
      // with a pulsing glow ring so it stands out at the radar edge.
      const isTgt = targetId !== undefined && b.id === targetId;
      if (isTgt) {
        color = '#ffb000';
        const pulse = 0.6 + Math.sin(performance.now() / 180) * 0.4;
        ctx.strokeStyle = `rgba(255,215,80,${pulse})`;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(ex, ey, 10, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate(angle);
      ctx.fillStyle = color;
      ctx.beginPath();
      const tip = isTgt ? 11 : 8;
      const tail = isTgt ? -6 : -4;
      const half = isTgt ? 7 : 5;
      ctx.moveTo(tip, 0);
      ctx.lineTo(tail, -half);
      ctx.lineTo(tail, half);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      // Distance label
      ctx.fillStyle = color;
      ctx.font = isTgt ? 'bold 9px monospace' : '8px monospace';
      ctx.textAlign = 'center';
      const labelR = R - 18;
      const lx = cx + (rx / len) * labelR;
      const ly = cy - (ry / len) * labelR;
      ctx.fillText(`${Math.round(b.dist / 1000)}k`, lx, ly);
    }

    // === Center dot (player) ===
    ctx.fillStyle = '#ffb000';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 8);
    ctx.lineTo(cx + 5, cy + 4);
    ctx.lineTo(cx - 5, cy + 4);
    ctx.closePath();
    ctx.fill();

    // N marker
    ctx.fillStyle = '#ffb000';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('N', cx, cy - R - 0);
  }, [blips, offRadar, heading, targetId]);

  return (
    <canvas
      ref={canvasRef}
      width={172}
      height={172}
      style={{ width: 172, height: 172, display: 'block', filter: 'drop-shadow(0 0 6px rgba(255,176,0,0.45))' }}
    />
  );
}

interface MinimapProps {
  blips: MinimapBlip[];
  playerPos: { x: number; y: number; z: number };
  playerHeading: number;
  targetId?: number;
  size?: number;
  range?: number; // world units shown from center
  // === §335 s02: 世界空间区域(防空圈 / 战舰射界)与空爆弹预警 ==================
  // 引擎只在这些东西存在时给值(其它关卡给空数组/null), 所以照旧渲染不受影响。
  zones?: { x: number; z: number; r: number; color: 'friendly' | 'hostile' | 'danger'; label?: string }[];
  airburst?: { x: number; z: number; r: number; countdown: number } | null;
}

// A tactical map that shows the world from above with player at center,
// rotated so player heading points up. Shows enemy/ally positions,
// altitude tick, and target lock indicator.
export function Minimap({ blips, playerPos, playerHeading, targetId, size = 220, range = 14000, zones, airburst }: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const W = c.width;
    const H = c.height;
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H) / 2 - 4;

    // Square frame
    const frameColor = 'rgba(255,176,0,0.85)';

    // === §337 去掉底/边框 (per user request: "原本的分数杂项不变但是去掉框") =====
    // 原来这里画一块半透明底 + 方框; 现在只保留**红十字准星**(下)与刻度数字, 让雷达
    // 融进画面(与右下武器面板同样去框)。战场底色由地形/天空透出来。
    // 若要让雷达在亮背景上也清楚, 只留中心附近一层很淡的暗角(下面这圈径向渐变)。
    {
      const g = ctx.createRadialGradient(cx, cy, R * 0.15, cx, cy, R * 1.15);
      g.addColorStop(0, 'rgba(8,6,2,0.34)');
      g.addColorStop(1, 'rgba(8,6,2,0.06)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    // === 世界坐标轴的细网格(保留原来的比例尺刻度作用, 但更淡) ================
    ctx.strokeStyle = 'rgba(255,176,0,0.10)';
    ctx.lineWidth = 1;
    for (let i = -2; i <= 2; i++) {
      if (i === 0) continue;
      const x = cx + (i / 2) * R;
      const y = cy + (i / 2) * R;
      ctx.beginPath();
      ctx.moveTo(x, 4); ctx.lineTo(x, H - 4);
      ctx.moveTo(4, y); ctx.lineTo(W - 4, y);
      ctx.stroke();
    }
    // === 红十字准星(用户草图: 正方形里一个红十字) ===========================
    ctx.strokeStyle = 'rgba(255,60,50,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, 2); ctx.lineTo(cx, H - 2);
    ctx.moveTo(2, cy); ctx.lineTo(W - 2, cy);
    ctx.stroke();
    // 中心点
    ctx.fillStyle = 'rgba(255,90,80,0.9)';
    ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3);

    // === 距离刻度数字(per user request: "雷达切换的缩放比例尺越大, 这个数字越大") ====
    // 半径 R 对应 range 米 ⇒ 在 1/2 半径处标 range/2, 1/4 半径处标 range/4, 单位 km。
    // 数值直接由 range 算出 ⇒ 玩家在设置里放大雷达量程, 这些数字跟着变大。
    {
      ctx.fillStyle = 'rgba(255,209,122,0.85)';
      ctx.font = '8px monospace';
      ctx.textAlign = 'left';
      for (const f of [0.25, 0.5]) {
        const km = (range * f) / 1000;
        const label = km >= 1 ? `${km >= 10 ? km.toFixed(0) : km.toFixed(1)}km` : `${Math.round(km * 1000)}m`;
        for (const dirY of [-1, 1]) {
          const y = cy + dirY * R * f;
          ctx.fillText(label, cx + 3, y + 3);      // 右半边(避开竖准星)
          ctx.textAlign = 'right';
          ctx.fillText(label, cx - 3, y + 3);
          ctx.textAlign = 'left';
        }
      }
    }

    // === Rotate world around player so heading is up ===
    // 世界 delta → 地图坐标(前向永远朝上)。
    // heading = atan2(forward.x, forward.z)(度), 因此 forward = (sin h, cos h)。
    // 三维世界是 right-handed(three.js): 机体的"屏幕右"方向 = forward × up
    // = (−cos h, sin h), 而画布的 +x 才是屏幕右。
    // === 左右方向反转 (per user request) ===
    // 原公式按"世界 +X = 东 / heading 从北顺时针"推导, 与右手系矛盾 —— 实际把地图
    // 左右镜像了: 机体右侧的目标画在地图左侧, 转向时地图也朝反方向转。把横向分量
    // 取反后与屏幕左右一致(前向依然朝上)。
    //   screen X = dz*sin(h) - dx*cos(h)
    //   screen Y = -(dx*sin(h) + dz*cos(h))
    const toMap = (wx: number, wz: number) => {
      const dx = wx - playerPos.x;
      const dz = wz - playerPos.z;
      const hRad = playerHeading * Math.PI / 180;
      const mx = dz * Math.sin(hRad) - dx * Math.cos(hRad);
      const my = -(dx * Math.sin(hRad) + dz * Math.cos(hRad));
      return { x: cx + (mx / range) * R, y: cy + (my / range) * R };
    };

    // Clip to circle? We'll use square. Clip to square frame inset.
    ctx.save();
    ctx.beginPath();
    ctx.rect(2, 2, W - 4, H - 4);
    ctx.clip();

    // Range rings
    ctx.strokeStyle = 'rgba(255,176,0,0.22)';
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, (R * i) / 3, 0, Math.PI * 2);
      ctx.stroke();
    }

    // === §335 s02: 世界空间区域(防空圈 / 战舰射界) ============================
    // 平移到 toMap 后按 (r/range)*R 画弧 —— 世界半径 -> 屏幕半径是线性映射, 与
    // 距离刻度一致(量程 ring 也是这个换算)。圆可能远在量程之外, 会被上面的
    // rect 裁剪掉一部分, 这是正确行为(雷达只显示量程内)。
    if (zones && zones.length) {
      for (const zn of zones) {
        const p = toMap(zn.x, zn.z);
        const rp = (zn.r / range) * R;
        const col = zn.color === 'friendly' ? 'rgba(80,220,140,0.75)'
          : zn.color === 'hostile' ? 'rgba(255,90,70,0.75)'
          : 'rgba(255,190,60,0.8)';
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, rp, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = col.replace(/0\.\d+\)/, '0.10)');
        ctx.beginPath();
        ctx.arc(p.x, p.y, rp, 0, Math.PI * 2);
        ctx.fill();
        if (zn.label) {
          ctx.fillStyle = col;
          ctx.font = '7px monospace';
          ctx.textAlign = 'center';
          ctx.fillText(zn.label, p.x, p.y - rp - 2);
        }
      }
    }
    // === 空爆弹预警圈(红色实线 + 倒计时): "锁定的是发射瞬间的位置" =============
    if (airburst) {
      const p = toMap(airburst.x, airburst.z);
      const rp = (airburst.r / range) * R;
      const pulse = 0.45 + 0.55 * Math.abs(Math.sin(performance.now() / 120));
      ctx.strokeStyle = `rgba(255,60,50,${pulse.toFixed(2)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(3, rp), 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,120,110,0.95)';
      ctx.font = 'bold 8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`AIRBURST ${airburst.countdown.toFixed(1)}s`, p.x, p.y + 3);
    }

    // §337 原来的"边缘量程数字"(cx, 12 / H-4)已被**沿竖轴的 1/4、1/2 半径刻度数字**取代
    // (见上面"距离刻度数字"一段): 那组只在框边标满量程, 去框后飘在空处, 且信息更少。

    // === 重要单位(护航编队)标记: X + 细外圈 ==============================
    // 用户要求: 护航编队必须一眼认出来。颜色取亮绿 #54e08c —— 地图上敌红/友蓝/
    // 中立白/导弹琥珀/选中金都没占用绿色, 不会与既有语义冲突, 读作"保护这个"。
    // 尺寸由 R(本循环已有的地图半径)推出而不是写死像素 ⇒ 玩家改 size/uiScale 后
    // X 与地图比例保持一致, 不会在小图上糊成一团、在大图上小到看不见。
    const impK = Math.max(2.2, R / 40);
    const drawImportantMark = (px: number, py: number) => {
      ctx.strokeStyle = '#54e08c';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(px, py, impK + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1.8;
      const s = impK + 2.5;
      ctx.beginPath();
      ctx.moveTo(px - s, py - s);
      ctx.lineTo(px + s, py + s);
      ctx.moveTo(px + s, py - s);
      ctx.lineTo(px - s, py + s);
      ctx.stroke();
    };

    // Draw blips
    for (const b of blips) {
      const p = toMap(b.x, b.z);
      // Skip if off-map
      if (p.x < 4 || p.x > W - 4 || p.y < 4 || p.y > H - 4) {
        // === Off-map edge arrows: only the switched target / 重要单位(per user request) ===
        // Applies to every target category (air / sea / land) — only the
        // currently selected unit gets a direction arrow at the map edge.
        // ★ 重要单位(护航编队)例外: 圆雷达那边 engine 是把超范围的重要单位钳到环边
        //   强行显示的, 而战术地图量程(range)玩家可调 —— 出了量程整个消失就违背了
        //   "护航目标必须一眼认出来"。所以这里同样钳到边缘继续画(见下面的 X)。
        if (!b.isTarget && !b.important) continue;
        // Clamp to edge with arrow
        const dx = p.x - cx;
        const dy = p.y - cy;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const ex = cx + (dx / len) * (R - 6);
        const ey = cy + (dy / len) * (R - 6);
        let color = '#ff3b1f';
        if (b.type === 'ally') color = '#5ad2ff';
        else if (b.type === 'neutral') color = '#ffffff';
        else if (b.type === 'missile') color = '#ffd27a';
        ctx.fillStyle = color;
        ctx.save();
        ctx.translate(ex, ey);
        ctx.rotate(Math.atan2(dy, dx));
        ctx.beginPath();
        ctx.moveTo(5, 0);
        ctx.lineTo(-3, -3);
        ctx.lineTo(-3, 3);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        // === 重要单位(护航编队)在量程外: 钳到边缘的小点上再打 X ==============
        // (用户要求: 护航编队必须一眼认出来) 先画本体小点当锚, X 画在最上层。
        if (b.important) {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(ex, ey, 2.2, 0, Math.PI * 2);
          ctx.fill();
          drawImportantMark(ex, ey);
        }
        continue;
      }
      let color = '#ff3b1f';
      if (b.type === 'ally') color = '#5ad2ff';
      else if (b.type === 'neutral') color = '#ffffff';
      else if (b.type === 'missile') color = '#ffd27a';
      const isTgt = targetId !== undefined && b.id === targetId && b.type === 'enemy';
      if (isTgt) {
        // === Selected-target highlight (per user request: 战术地图高亮) ===
        // Pulsing gold ring + gold corner brackets so the switched target
        // pops out on the tactical map too.
        const pulse = 0.6 + Math.sin(performance.now() / 180) * 0.4;
        ctx.strokeStyle = `rgba(255,215,80,${pulse})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = '#ffb000';
        ctx.lineWidth = 1.6;
        const s = 7;
        const corners = [
          [p.x - s, p.y - s, 1, 0],
          [p.x - s, p.y - s, 0, 1],
          [p.x + s, p.y - s, -1, 0],
          [p.x + s, p.y - s, 0, 1],
          [p.x - s, p.y + s, 1, 0],
          [p.x - s, p.y + s, 0, -1],
          [p.x + s, p.y + s, -1, 0],
          [p.x + s, p.y + s, 0, -1],
        ];
        for (const [ox, oy, dx, dy] of corners) {
          ctx.beginPath();
          ctx.moveTo(ox, oy);
          ctx.lineTo(ox + dx * 4, oy + dy * 4);
          ctx.stroke();
        }
      }
      // Altitude chevron: ▲ if above player, ▼ if below
      const altDiff = b.y - playerPos.y;
      ctx.fillStyle = color;
      if (b.type === 'enemy') {
        ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
      } else if (b.type === 'ally') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
      } else if (b.type === 'neutral') {
        // === Neutral: diamond shape (per user request) ===
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - 4);
        ctx.lineTo(p.x + 4, p.y);
        ctx.lineTo(p.x, p.y + 4);
        ctx.lineTo(p.x - 4, p.y);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      // Small chevron for altitude
      if (Math.abs(altDiff) > 100) {
        ctx.fillStyle = color;
        ctx.beginPath();
        if (altDiff > 0) {
          ctx.moveTo(p.x, p.y - 6);
          ctx.lineTo(p.x - 2.5, p.y - 3);
          ctx.lineTo(p.x + 2.5, p.y - 3);
        } else {
          ctx.moveTo(p.x, p.y + 6);
          ctx.lineTo(p.x - 2.5, p.y + 3);
          ctx.lineTo(p.x + 2.5, p.y + 3);
        }
        ctx.closePath();
        ctx.fill();
      }
      // === 重要单位(护航编队): 在标记上再打一个 X + 细外圈 ==================
      // 用户要求: 护航编队必须一眼认出来 —— 与上方圆雷达 drawBlip 的做法保持一致。
      // 亮绿 X 不会和敌红/友蓝/中立白/导弹琥珀/选中金混淆; 画在本体标记之上。
      if (b.important) drawImportantMark(p.x, p.y);
    }

    ctx.restore();

    // === Player aircraft marker (center, points up) ===
    ctx.fillStyle = '#ffb000';
    ctx.strokeStyle = '#ffb000';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 8);
    ctx.lineTo(cx + 6, cy + 5);
    ctx.lineTo(cx, cy + 2);
    ctx.lineTo(cx - 6, cy + 5);
    ctx.closePath();
    ctx.fill();

    // === §337 外框/四角括号**去掉** (per user request: "原本的分数杂项不变但是去掉框") ===
    // 原来这里画方框 + 四角括号。去框后靠红十字准星 + 刻度数字就能界定范围,
    // 画面也更干净(与右下武器面板同样去框)。
    // ⚠ 若要临时看回框体: 把 frameColor 那两行 strokeRect 取消注释即可。

    // Title
    ctx.fillStyle = 'rgba(255,209,122,0.85)';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('战术地图', 8, 14);
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(playerPos.x)} / ${Math.round(playerPos.z)}`, W - 8, 14);
  }, [blips, playerPos, playerHeading, targetId, range, zones, airburst]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      style={{ width: size, height: size, display: 'block', filter: 'drop-shadow(0 0 8px rgba(255,176,0,0.4))' }}
    />
  );
}
