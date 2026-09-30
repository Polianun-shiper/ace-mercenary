// ============================================================================
// 目标蓝图线稿 —— 卡片上的"目标识别图"
// ============================================================================
// 项目里没有任何单位图标/照片素材, 地面单位也没有 3D 模型可截, 所以卡片上的这张图
// **现画**: 按单位类型画一张终端风的线框示意图(雷达天线、激光防空炮、SAM 发射车、
// 坦克、护卫舰、空中战舰…), 琥珀单色 + 网格底 + 角标 + 图注 —— 像技术手册里的一页。
//
// 与简报的其它部分一样: 零外部资源、零加载。首次出现时画一次(约 1-3ms), 之后
// 就是一张普通 canvas。
//
// 为什么不用 3D 截图: 这些地面单位在引擎里是程序化拼出来的, 没有独立模型文件;
// 而为了 4 张小图去建一个离屏 renderer + 光照, 成本远高于画几条线。

import type { BlueprintKind } from './briefing-intel';

const MONO = '"Arial Narrow", "Liberation Sans Narrow", Consolas, monospace';

/** 画布尺寸(2x 超采样, CSS 上按一半显示就足够锐利) */
const W = 420;
const H = 224;

const AMBER = '#ffb000';
const AMBER_DIM = '#8a5a12';
const AMBER_DEEP = 'rgba(255,176,0,0.22)';

/**
 * 把某个单位类型的线稿画到 canvas 上。
 * canvas 的 width/height 由本函数设置(调用方不必管尺寸)。
 */
export function paintUnitBlueprint(canvas: HTMLCanvasElement, kind: BlueprintKind, code: string): void {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);

  // --- 底: 近黑 + 网格(工程图感) ---
  ctx.fillStyle = '#070302';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = AMBER_DEEP;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= W; x += 14) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (let y = 0; y <= H; y += 14) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();

  // --- 地面线 / 基准线 ---
  const groundY = H - 52;
  ctx.strokeStyle = AMBER_DIM;
  ctx.setLineDash([7, 5]);
  ctx.beginPath();
  ctx.moveTo(18, groundY);
  ctx.lineTo(W - 18, groundY);
  ctx.stroke();
  ctx.setLineDash([]);

  // --- 本体 ---
  ctx.save();
  ctx.strokeStyle = AMBER;
  ctx.lineWidth = 2.2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  draw(ctx, kind, W / 2, groundY);
  ctx.restore();

  // --- 四角角标(终端语汇: 不用圆角, 用角) ---
  ctx.strokeStyle = AMBER_DIM;
  ctx.lineWidth = 2;
  const c = 18;
  for (const [x, y, sx, sy] of [[6, 6, 1, 1], [W - 6, 6, -1, 1], [6, H - 6, 1, -1], [W - 6, H - 6, -1, -1]] as const) {
    ctx.beginPath();
    ctx.moveTo(x + sx * c, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + sy * c);
    ctx.stroke();
  }

  // --- 图注 ---
  ctx.fillStyle = AMBER;
  ctx.font = `700 20px ${MONO}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(code, 16, 30);
  ctx.fillStyle = AMBER_DIM;
  ctx.font = `600 14px ${MONO}`;
  ctx.fillText('RECON IMAGERY · BLUEPRINT', 16, 48);
  // 右下: 类型码 + 视角刻度
  ctx.textAlign = 'right';
  ctx.fillText(kind.toUpperCase(), W - 16, 30);
  ctx.fillText('SIDE VIEW · 1:200', W - 16, 48);
  ctx.textAlign = 'left';
  // 比例尺
  ctx.strokeStyle = AMBER_DIM;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(16, H - 18);
  ctx.lineTo(16 + 70, H - 18);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(16, H - 23); ctx.lineTo(16, H - 13);
  ctx.moveTo(16 + 70, H - 23); ctx.lineTo(16 + 70, H - 13);
  ctx.stroke();
  ctx.fillStyle = AMBER_DIM;
  ctx.font = `600 13px ${MONO}`;
  ctx.fillText('10 M', 92, H - 14);
}

// ============================================================================
// 小工具
// ============================================================================
type Ctx = CanvasRenderingContext2D;

function line(ctx: Ctx, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}
function rect(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  ctx.strokeRect(x, y, w, h);
}
function poly(ctx: Ctx, pts: readonly (readonly [number, number])[], close = true): void {
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
  if (close) ctx.closePath();
  ctx.stroke();
}
function circle(ctx: Ctx, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
}
function arc(ctx: Ctx, x: number, y: number, r: number, a0: number, a1: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, a0, a1);
  ctx.stroke();
}
/** 履带/车轮(一个被压扁的胶囊) */
function track(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  ctx.beginPath();
  ctx.moveTo(x + h / 2, y);
  ctx.lineTo(x + w - h / 2, y);
  ctx.arc(x + w - h / 2, y + h / 2, h / 2, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x + h / 2, y + h);
  ctx.arc(x + h / 2, y + h / 2, h / 2, Math.PI / 2, -Math.PI / 2);
  ctx.closePath();
  ctx.stroke();
  // 负重轮
  for (let i = 0; i < 4; i += 1) {
    circle(ctx, x + h / 2 + (i * (w - h)) / 3, y + h / 2, h * 0.22);
  }
}

// ============================================================================
// 各类型的线稿(cx = 水平中心, gy = 地面线 y)
// ============================================================================
function draw(ctx: Ctx, kind: BlueprintKind, cx: number, gy: number): void {
  switch (kind) {
    case 'radar': {
      // 抛物面天线 + 支架 + 机房
      poly(ctx, [[cx - 96, gy], [cx - 96, gy - 16], [cx - 40, gy - 16], [cx - 40, gy]]);
      line(ctx, cx - 68, gy - 16, cx - 68, gy - 44);
      // 天线面(开口朝左上) + 馈源
      arc(ctx, cx - 44, gy - 74, 44, Math.PI * 0.72, Math.PI * 1.62);
      poly(ctx, [[cx - 68, gy - 44], [cx - 26, gy - 62], [cx - 30, gy - 46]], false);
      line(ctx, cx - 52, gy - 66, cx - 16, gy - 86);
      circle(ctx, cx - 16, gy - 86, 4);
      // 辐射弧
      for (const r of [40, 58, 76]) arc(ctx, cx - 16, gy - 86, r, Math.PI * 1.15, Math.PI * 1.62);
      break;
    }
    case 'laser_aa': {
      // 发电/冷却机组 + 转塔 + 激光器阵列 + 光束
      rect(ctx, cx + 6, gy - 30, 62, 30);
      line(ctx, cx + 16, gy - 30, cx + 16, gy);
      line(ctx, cx + 58, gy - 30, cx + 58, gy);
      track(ctx, cx - 96, gy - 20, 100, 20);
      circle(ctx, cx - 46, gy - 30, 12);
      // 激光器: 三根平行腔体, 仰角向上
      for (let i = 0; i < 3; i += 1) {
        const ox = -14 + i * 9;
        poly(ctx, [
          [cx - 60 + ox, gy - 34],
          [cx - 22 + ox, gy - 74],
          [cx - 12 + ox, gy - 68],
          [cx - 50 + ox, gy - 28],
        ]);
      }
      // 光束
      ctx.save();
      ctx.strokeStyle = 'rgba(255,59,31,0.75)';
      ctx.lineWidth = 2.6;
      line(ctx, cx - 16, gy - 72, cx - 16 + 74, gy - 168);
      ctx.restore();
      break;
    }
    case 'sam': {
      // 发射车 + 两根倾斜发射筒 + 驾驶室
      track(ctx, cx - 104, gy - 22, 148, 22);
      rect(ctx, cx - 40, gy - 46, 116, 24);
      rect(ctx, cx + 84, gy - 44, 26, 22);
      for (let i = 0; i < 2; i += 1) {
        const ox = -84 + i * 26;
        poly(ctx, [
          [cx + ox + 8, gy - 46],
          [cx + ox + 44, gy - 106],
          [cx + ox + 58, gy - 100],
          [cx + ox + 22, gy - 40],
        ]);
      }
      line(ctx, cx + 44, gy - 132, cx + 44, gy - 100);
      break;
    }
    case 'aa': {
      // 小型履带底盘 + 双联装高炮
      track(ctx, cx - 78, gy - 18, 100, 18);
      rect(ctx, cx - 62, gy - 36, 68, 18);
      circle(ctx, cx - 28, gy - 42, 10);
      for (const d of [-6, 6]) {
        poly(ctx, [
          [cx - 34 + d, gy - 46],
          [cx - 14 + d + 44, gy - 108],
          [cx - 6 + d + 44, gy - 104],
          [cx - 26 + d, gy - 42],
        ]);
      }
      break;
    }
    case 'tank': {
      // 车体 + 炮塔 + 炮管 + 履带
      track(ctx, cx - 92, gy - 20, 184, 20);
      poly(ctx, [[cx - 84, gy - 20], [cx + 76, gy - 20], [cx + 60, gy - 46], [cx - 70, gy - 46]]);
      poly(ctx, [[cx - 44, gy - 46], [cx + 30, gy - 46], [cx + 18, gy - 68], [cx - 32, gy - 68]]);
      rect(ctx, cx - 8, gy - 78, 18, 10); // 舱盖
      line(ctx, cx + 20, gy - 62, cx + 108, gy - 74); // 炮管
      break;
    }
    case 'artillery': {
      // 底盘 + 大仰角炮管 + 驻锄
      track(ctx, cx - 96, gy - 20, 150, 20);
      rect(ctx, cx - 60, gy - 38, 84, 18);
      poly(ctx, [[cx + 54, gy], [cx + 66, gy - 34], [cx + 84, gy - 30], [cx + 78, gy]], false);
      poly(ctx, [
        [cx - 44, gy - 40],
        [cx + 44, gy - 132],
        [cx + 60, gy - 126],
        [cx - 28, gy - 34],
      ]);
      // 炮口制退器
      rect(ctx, cx + 36, gy - 138, 30, 12);
      break;
    }
    case 'bunker': {
      // 混凝土掩体 + 射击口 + 覆土
      poly(ctx, [[cx - 104, gy], [cx - 96, gy - 54], [cx + 96, gy - 54], [cx + 104, gy]]);
      rect(ctx, cx - 58, gy - 46, 62, 12);
      poly(ctx, [[cx - 118, gy - 54], [cx - 60, gy - 76], [cx + 52, gy - 76], [cx + 116, gy - 54]], false);
      for (let i = 0; i < 5; i += 1) line(ctx, cx - 110 + i * 10, gy - 54, cx - 108 + i * 10, gy);
      break;
    }
    case 'ship_small': {
      // 护卫舰侧视: 舰体 + 上层建筑 + 桅杆 + 舰炮
      poly(ctx, [[cx - 130, gy - 26], [cx + 118, gy - 26], [cx + 142, gy - 48], [cx - 108, gy - 48]]);
      rect(ctx, cx - 20, gy - 74, 78, 26);
      rect(ctx, cx - 4, gy - 92, 40, 18);
      rect(ctx, cx - 46, gy - 60, 20, 12); // 舰炮
      line(ctx, cx - 36, gy - 60, cx - 76, gy - 66);
      line(ctx, cx + 16, gy - 92, cx + 16, gy - 130); // 桅杆
      line(ctx, cx - 8, gy - 112, cx + 40, gy - 112);
      arc(ctx, cx + 52, gy - 84, 12, Math.PI, Math.PI * 2); // 雷达
      poly(ctx, [[cx + 104, gy - 44], [cx + 130, gy - 64], [cx + 140, gy - 48]], false);
      break;
    }
    case 'ship_large': {
      poly(ctx, [[cx - 178, gy - 30], [cx + 156, gy - 30], [cx + 186, gy - 56], [cx - 150, gy - 56]]);
      rect(ctx, cx - 60, gy - 92, 130, 36);
      rect(ctx, cx - 36, gy - 118, 74, 26);
      rect(ctx, cx - 14, gy - 138, 30, 20);
      line(ctx, cx - 54, gy - 92, cx - 54, gy - 148);
      line(ctx, cx + 44, gy - 92, cx + 44, gy - 142);
      line(ctx, cx - 74, gy - 124, cx - 16, gy - 124);
      // 主炮 ×2
      rect(ctx, cx - 120, gy - 70, 26, 14);
      line(ctx, cx - 108, gy - 70, cx - 158, gy - 76);
      rect(ctx, cx + 96, gy - 66, 22, 12);
      line(ctx, cx + 108, gy - 66, cx + 150, gy - 70);
      // 垂发单元
      for (let i = 0; i < 6; i += 1) rect(ctx, cx + 58 + i * 10, gy - 66, 8, 10);
      break;
    }
    case 'aircraft': {
      // 俯视平面图: 机身 + 后掠翼 + 尾翼(画在基准线上方)
      const by = gy - 46;
      poly(ctx, [[cx, by - 30], [cx + 10, by - 6], [cx + 12, by + 34], [cx - 12, by + 34], [cx - 10, by - 6]]);
      poly(ctx, [[cx - 8, by - 2], [cx - 66, by + 30], [cx - 74, by + 40], [cx - 6, by + 16]]);
      poly(ctx, [[cx + 8, by - 2], [cx + 66, by + 30], [cx + 74, by + 40], [cx + 6, by + 16]]);
      poly(ctx, [[cx - 8, by + 26], [cx - 34, by + 46], [cx - 36, by + 50], [cx - 6, by + 38]]);
      poly(ctx, [[cx + 8, by + 26], [cx + 34, by + 46], [cx + 36, by + 50], [cx + 6, by + 38]]);
      // 挂载点
      for (const ox of [-30, -18, 18, 30]) circle(ctx, cx + ox, by + 24, 3.4);
      // 航向箭头
      ctx.save();
      ctx.strokeStyle = 'rgba(255,59,31,0.7)';
      line(ctx, cx, by - 46, cx, by - 74);
      poly(ctx, [[cx - 7, by - 68], [cx, by - 80], [cx + 7, by - 68]], false);
      ctx.restore();
      break;
    }
    case 'airship': {
      // 空中战舰侧视: 长箱形舰体 + 分段隔框 + 尾部舵面 + 挂点炮塔
      poly(ctx, [
        [cx - 186, gy - 104],
        [cx + 130, gy - 104],
        [cx + 186, gy - 128],
        [cx + 130, gy - 152],
        [cx - 186, gy - 152],
        [cx - 200, gy - 128],
      ]);
      // 隔框
      for (let i = 0; i < 9; i += 1) {
        const x = cx - 180 + i * 44;
        line(ctx, x, gy - 106, x - 8, gy - 150);
      }
      // 尾部舵面
      poly(ctx, [[cx - 150, gy - 104], [cx - 196, gy - 70], [cx - 214, gy - 74], [cx - 168, gy - 110]], false);
      poly(ctx, [[cx - 150, gy - 152], [cx - 196, gy - 186], [cx - 214, gy - 182], [cx - 168, gy - 146]], false);
      // 挂点武器(六个面的火力簇)
      for (const ox of [-140, -60, 20, 100, 160]) {
        rect(ctx, cx + ox - 8, gy - 116, 16, 12);
        line(ctx, cx + ox, gy - 104, cx + ox + 8, gy - 92);
      }
      // 舰桥
      rect(ctx, cx + 40, gy - 178, 56, 26);
      line(ctx, cx + 68, gy - 178, cx + 68, gy - 198);
      break;
    }
    default: {
      // 未编目目标: 十字分划 + 方框
      rect(ctx, cx - 60, gy - 108, 120, 92);
      line(ctx, cx - 84, gy - 62, cx + 84, gy - 62);
      line(ctx, cx, gy - 130, cx, gy + 6);
      circle(ctx, cx, gy - 62, 24);
      break;
    }
  }
}
