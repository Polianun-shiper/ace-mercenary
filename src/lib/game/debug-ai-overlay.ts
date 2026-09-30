/**
 * === §344 AI 血量实时显示 + 击杀播报(控制台调试工具) ==========================
 * 用户: "在控制台里加上能实时显示每个ai单位血量的工具，然后实时报告谁打死了谁"。
 *
 * 设计: 引擎侧**自包含**的 DOM 覆盖层(不经过 React/HudState), 理由是它就是个调试工具:
 *   控制台 `hp on|off|all` / `kf on|off` 立刻开关, 不参与正式 HUD 的布局与刷新节奏。
 *
 * 画什么:
 *   · AI 血量: 每个单位(敌机/僚机/护航编队; `all` 再加地面与舰船)在**屏幕投影位置**上
 *     挂一个小标签: 名称 + 血条 + 百分比 + 距离; 左上角再给一份汇总(数量/最近/最危)。
 *   · 击杀播报: 右上角滚动最近 8 条 "[时间] 击杀者 → 被击落者(武器)"。
 *
 * [i] 血条颜色按比例分档(>60% 绿 / >30% 黄 / 其余红), 与 HUD 的语义色一致。
 * [i] 单位多于上限(LIMIT)时只画最近的 LIMIT 个, 免得屏幕糊成一片。
 */

export interface DebugAiUnit {
  name: string;
  position: { x: number; y: number; z: number };
  hp: number;
  maxHp: number;
  isAlly: boolean;
  /** 附带一行小字(AI 状态 / 角色等) */
  note?: string;
}

interface FeedEntry { t: number; text: string; }

const LIMIT = 24;

export class DebugAiOverlay {
  private root: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private feed: FeedEntry[] = [];
  hpOn = false;
  groundOn = false;
  feedOn = false;

  /** 挂到渲染容器上(幂等) */
  attach(container: HTMLElement): void {
    if (this.root) return;
    const root = document.createElement('div');
    root.id = 'ai-debug-overlay';
    root.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:40';
    const cv = document.createElement('canvas');
    cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
    root.appendChild(cv);
    container.appendChild(root);
    this.root = root;
    this.canvas = cv;
    this.ctx = cv.getContext('2d');
  }

  detach(): void {
    if (this.root?.parentElement) this.root.parentElement.removeChild(this.root);
    this.root = null; this.canvas = null; this.ctx = null;
  }

  /** 记录一条击杀(由引擎在 killEnemy/killWingman 里调用) */
  reportKill(killer: string, victim: string, weapon: string): void {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const text = `${hh}:${mm}:${ss}  ${killer} -> ${victim}  [${weapon}]`;
    this.feed.push({ t: performance.now(), text });
    if (this.feed.length > 8) this.feed = this.feed.slice(-8);
    // 浏览器控制台也留一份(事后可以整段复制)
    console.info(`[击杀] ${killer} -> ${victim} [${weapon}]`);
  }

  /** 每帧调用(engine.render 末尾)。proj = 世界坐标 → 屏幕像素 的投影函数 */
  frame(
    proj: (x: number, y: number, z: number) => { x: number; y: number } | null,
    units: DebugAiUnit[],
    camPos: { x: number; y: number; z: number },
  ): void {
    const cv = this.canvas, ctx = this.ctx, root = this.root;
    if (!cv || !ctx || !root) return;
    const on = this.hpOn || this.feedOn;
    root.style.display = on ? 'block' : 'none';
    if (!on) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = window.innerWidth, H = window.innerHeight;
    if (cv.width !== Math.floor(W * dpr) || cv.height !== Math.floor(H * dpr)) {
      cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // === AI 血量 ===
    if (this.hpOn) {
      const list = units
        .map((u) => ({ u, d: Math.hypot(u.position.x - camPos.x, u.position.y - camPos.y, u.position.z - camPos.z) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, LIMIT);
      let shown = 0, hurt = 0;
      for (const { u, d } of list) {
        const p = proj(u.position.x, u.position.y, u.position.z);
        if (!p) continue;
        if (p.x < -60 || p.x > W + 60 || p.y < -40 || p.y > H + 40) continue;
        shown++;
        const frac = Math.max(0, Math.min(1, u.hp / Math.max(1, u.maxHp)));
        const col = frac > 0.6 ? '#54e08c' : frac > 0.3 ? '#ffc44d' : '#ff5a4d';
        if (frac < 0.3) hurt++;
        const w = 62, h = 5;
        // 名称 + 距离
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        ctx.fillStyle = u.isAlly ? '#8fd0ff' : '#ffd27a';
        ctx.fillText(`${u.name} ${Math.round(d / 100) / 10}km`, p.x + 8, p.y - 6);
        // 血条
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(p.x + 8, p.y, w, h);
        ctx.fillStyle = col;
        ctx.fillRect(p.x + 8, p.y, w * frac, h);
        ctx.strokeStyle = 'rgba(255,176,0,0.7)';
        ctx.lineWidth = 1;
        ctx.strokeRect(p.x + 8.5, p.y + 0.5, w, h);
        // 数值
        ctx.fillStyle = col;
        ctx.fillText(`${Math.round(u.hp)}/${Math.round(u.maxHp)}`, p.x + 8 + w + 4, p.y + h);
        if (u.note) { ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fillText(u.note, p.x + 8, p.y + h + 10); }
      }
      // 汇总
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(8, H - 46, 210, 38);
      ctx.fillStyle = '#ffd27a';
      ctx.font = '11px monospace';
      ctx.fillText(`AI 血量: ${shown} 个显示 / 共 ${units.length}`, 14, H - 30);
      ctx.fillStyle = hurt ? '#ff5a4d' : '#54e08c';
      ctx.fillText(`危急(<30%): ${hurt}`, 14, H - 16);
    }

    // === 击杀播报 ===
    if (this.feedOn && this.feed.length) {
      const lineH = 15;
      const boxH = this.feed.length * lineH + 24;
      const boxW = 320;
      const x0 = W - boxW - 10, y0 = 10;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(x0, y0, boxW, boxH);
      ctx.strokeStyle = 'rgba(255,176,0,0.5)';
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, boxW, boxH);
      ctx.fillStyle = '#ffd27a';
      ctx.font = '11px monospace';
      ctx.textAlign = 'left';
      ctx.fillText('击杀播报 (谁打死了谁)', x0 + 8, y0 + 15);
      ctx.font = '10px monospace';
      this.feed.forEach((f, i) => {
        const age = (performance.now() - f.t) / 1000;
        ctx.fillStyle = age < 6 ? '#ffffff' : 'rgba(255,255,255,0.55)';
        ctx.fillText(f.text, x0 + 8, y0 + 15 + (i + 1) * lineH);
      });
    }
  }

  /** 状态文本(控制台读数用) */
  status(): string {
    return `AI 血量显示=${this.hpOn ? 'ON' : 'off'}${this.groundOn ? '(含地面/舰船)' : ''}`
      + ` · 击杀播报=${this.feedOn ? 'ON' : 'off'} · 已记录 ${this.feed.length} 条`;
  }
}
