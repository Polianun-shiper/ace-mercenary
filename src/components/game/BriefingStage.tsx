'use client';

// ============================================================================
// 简报舞台组件 —— 3D 画布 + 标记标签浮层 + 目标卡片浮层
// ============================================================================
// 这一层只做"接线": 建渲染器、跑 rAF、把 3D 侧投出来的锚点搬到 DOM 上。所有编排都
// 在 briefing-stage.ts 里(纯 three, 无 React), 于是同一个舞台能被两处复用:
//   * StoryBrief 的剧情简报 —— mode='sequence', 六拍过场 + 卡片 + 标签
//   * Menus 的任务简报预览 —— mode='preview', 慢速环绕, 2D/3D 可切, 不出卡片
//
// 沿用旧版简报的每一条硬规矩:
//   * 渲染器/场景全部在 effect 内创建、在清理里全部释放(菜单反复进出最容易漏 WebGL
//     上下文, 浏览器上限约 16 个); 进 effect 先清掉残留 canvas 兜底。
//   * 不逐帧 setState —— 标签与卡片的位置直接写 style.transform, 且带 0.75px 死区;
//     每 3 帧才同步一次。整段过场里 React 只重渲染 6 次(拍号变化)。
//   * 无 WebGL 时退化成"只剩终端 UI", 绝不白屏。

import { useEffect, useImperativeHandle, useRef, type ReactNode, type Ref } from 'react';
import * as THREE from 'three';
import { createBriefingStage, beatAt, type BriefingStage as Stage } from '@/lib/game/briefing-stage';
import { toneColor, type BriefingIntel } from '@/lib/game/briefing-intel';
import { paintUnitBlueprint } from '@/lib/game/briefing-blueprint';
import { t } from '@/lib/game/i18n';

export interface BriefingStageHandle {
  /** 跳到时间轴上的某一刻(快进到 HOLD_T) */
  seek: (t: number) => void;
  /** 预览模式: 切 2D 地图 / 3D 网格 */
  setPreviewView: (v: 'map' | 'grid') => void;
}

export interface BriefingStageProps {
  intel: BriefingIntel;
  mode: 'sequence' | 'preview';
  en: boolean;
  missionId: string;
  codename: string;
  /** 是否渲染目标卡片(预览模式关掉, 免得太挡) */
  showCards?: boolean;
  /** 拍号变化回调(每拍只调一次, 不是每帧) */
  onBeat?: (beat: number) => void;
  ref?: Ref<BriefingStageHandle>;
}

/** 建渲染器。无 WebGL 时返回 null(简报屏退化成纯终端 UI, 不能白屏)。 */
function makeRenderer(): THREE.WebGLRenderer | null {
  try {
    return new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
  } catch {
    return null;
  }
}

/** 威胁等级条(5 格) */
function ThreatBar({ level, tone }: { level: number; tone: string }) {
  return (
    <span className="inline-flex items-center gap-[2px]" aria-label={`threat ${level}/5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className="inline-block h-[9px] w-[5px]"
          style={{
            background: i <= level ? tone : 'transparent',
            border: `1px solid ${i <= level ? tone : 'var(--crt-amber-deep)'}`,
          }}
        />
      ))}
    </span>
  );
}

/** HTML 叠层的共用浮层元素(标签与卡片都靠它接 3D 投影) */
function OverlayItem({
  tone,
  children,
  variant,
}: {
  tone: string;
  children: ReactNode;
  variant: 'label' | 'card';
}) {
  if (variant === 'label') {
    return (
      <span
        className="crt-label px-1 py-[1px] leading-none"
        style={{ color: tone, border: `1px solid ${tone}66`, background: 'rgba(6,4,1,0.55)' }}
      >
        {children}
      </span>
    );
  }
  return (
    <div
      className="crt-panel flex w-[210px] flex-col"
      style={{ borderColor: `${tone}88`, background: 'rgba(6,4,1,0.82)' }}
    >
      {children}
    </div>
  );
}

/** 卡片上的目标识别图: 现画一次, 之后就是一张普通 canvas(用 dataset 记账, 不重复画) */
function Blueprint({ card }: { card: { blueprint: BriefingIntel['cards'][number]['blueprint']; code: string } }) {
  return (
    <canvas
      width={420}
      height={224}
      ref={(el) => {
        if (!el || el.dataset.painted) return;
        el.dataset.painted = '1';
        paintUnitBlueprint(el, card.blueprint, card.code);
      }}
      className="block h-[86px] w-full"
    />
  );
}

export function BriefingStage({
  intel, mode, en, missionId, codename, showCards = true, onBeat, ref,
}: BriefingStageProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const labelHostRef = useRef<HTMLDivElement>(null);
  const cardHostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Stage | null>(null);
  /** 调试钩子的落点(在 effect 里被赋成"画任意一拍"的闭包) */
  const manualFrameRef = useRef<((t: number) => void) | null>(null);
  // 回调放 ref: onBeat 每次渲染都可能是新函数, 放进 effect 依赖会让场景反复重建
  const onBeatRef = useRef(onBeat);

  useEffect(() => { onBeatRef.current = onBeat; }, [onBeat]);

  useImperativeHandle(ref, () => ({
    seek: (target: number) => stageRef.current?.seek(target),
    setPreviewView: (v: 'map' | 'grid') => stageRef.current?.setPreviewView(v),
  }), []);

  // 开发期把"渲染任意一拍"挂到 window 上: headless / 后台标签里 rAF 根本不跑, 而六拍
  // 里中间几拍各只持续 2-4 秒 —— 有这个钩子才能用一行脚本稳定复现任意一拍的画面做
  // 视觉回归(scripts/ 与 .shots/ 那套验收流程就是这么跑的)。
  // 它同时驱动 3D 与浮层, 所以截出来的画面是完整的(不只是画布)。
  // 生产构建整段被 NODE_ENV 判定删掉。
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    const w = window as unknown as {
      __briefingFrame?: (t: number) => void;
      __briefingStats?: () => unknown;
      __briefingMapPng?: () => string | null;
    };
    w.__briefingFrame = (target: number) => manualFrameRef.current?.(target);
    // 把现画的地图贴图 dump 出来 —— 它是一张程序化生成的画布, 有问题只能看它本身
    w.__briefingMapPng = () => stageRef.current?.mapImage?.toDataURL('image/png') ?? null;
    // 推导结果的自查(多少个单位/航线/区域/卡片、世界范围多大) —— 视觉回归时先看数字,
    // 比对着截图猜"这个圆为什么没画出来"快得多。
    w.__briefingStats = () => ({
      mission: intel.region,
      units: intel.units.length,
      labelled: intel.units.filter((u) => u.labelled).length,
      routes: intel.routes.map((r) => `${r.id}:${r.points.length}`),
      areas: intel.areas.map((a) => `${a.id}:${a.tone}:r${a.radius}`),
      cards: intel.cards.map((c) => `${c.code}/${c.title}`),
      world: intel.world,
    });
    return () => { delete w.__briefingFrame; delete w.__briefingStats; delete w.__briefingMapPng; };
  }, [intel]);

  // -------- 舞台 --------
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const labelHost = labelHostRef.current;
    const cardHost = cardHostRef.current;

    // 兜底: 上一次清理若因异常没跑到, 容器里可能留着旧 canvas —— 先清掉再建,
    // 否则每次进出都会多占一个 WebGL 上下文。
    mount.querySelectorAll('canvas').forEach((c) => c.remove());

    const width = Math.max(1, mount.clientWidth);
    const height = Math.max(1, mount.clientHeight);

    const renderer = makeRenderer();
    if (!renderer) return;
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const stage = createBriefingStage(intel, {
      en, mode, missionId, codename,
      anisotropy: renderer.capabilities.getMaxAnisotropy(),
    });
    stage.setSize(width, height);
    stageRef.current = stage;

    // -------- 锚点 -> DOM(每 3 帧一次 + 0.75px 死区) --------
    const labelEls = labelHost ? (Array.from(labelHost.children) as HTMLElement[]) : [];
    const cardEls = cardHost ? (Array.from(cardHost.children) as HTMLElement[]) : [];
    const nLabel = intel.units.length;
    const nCard = intel.cards.length;
    const lastX = new Float32Array(nLabel + nCard).fill(-9999);
    const lastY = new Float32Array(nLabel + nCard).fill(-9999);
    const lastA = new Float32Array(nLabel + nCard).fill(-1);
    let viewW = width;
    let viewH = height;
    let frame = 0;

    const place = (
      el: HTMLElement,
      i: number,
      ndcX: number,
      ndcY: number,
      alpha: number,
      on: boolean,
      yOffsetPct: number,
    ): void => {
      if (!on || alpha <= 0.02) {
        if (lastA[i] !== 0) {
          el.style.opacity = '0';
          lastA[i] = 0;
        }
        return;
      }
      const px = (ndcX * 0.5 + 0.5) * viewW;
      const py = (0.5 - ndcY * 0.5) * viewH;
      if (Math.abs(px - lastX[i]) >= 0.75 || Math.abs(py - lastY[i]) >= 0.75) {
        // 卡片整体坐在锚点上方(yOffsetPct = -100 表示底边贴锚点)
        el.style.transform = `translate(-50%, ${yOffsetPct}%) translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`;
        lastX[i] = px;
        lastY[i] = py;
      }
      if (Math.abs(alpha - lastA[i]) > 0.02) {
        el.style.opacity = alpha.toFixed(2);
        lastA[i] = alpha;
      }
    };

    const syncOverlays = (): void => {
      frame += 1;
      if (frame % 3 !== 0) return;
      const la = stage.labelAnchors;
      for (let i = 0; i < labelEls.length; i += 1) {
        const o = i * 4;
        place(labelEls[i], i, la[o], la[o + 1], la[o + 2], la[o + 3] > 0.5, -50);
      }
      const ca = stage.cardAnchors;
      for (let i = 0; i < cardEls.length; i += 1) {
        const o = i * 4;
        place(cardEls[i], nLabel + i, ca[o], ca[o + 1], ca[o + 2], ca[o + 3] > 0.5, -100);
      }
    };

    // -------- 主循环 --------
    // THREE.Timer(r185 起取代已弃用的 Clock; Clock 会打 deprecation 警告)。
    const timer = new THREE.Timer();
    let lastBeat = -1;

    /** 报告拍号(只在**变化**时报一次 —— 整段过场 React 最多重渲染 6 次) */
    const reportBeat = (): void => {
      if (mode !== 'sequence') return;
      // 用 stage.time() 而不是 elapsed: 快进之后时间轴位置是 elapsed + 偏移, 用 elapsed
      // 判拍会让"快进到留驻段"之后抬头条还显示着第 1 拍。
      const b = beatAt(stage.time());
      if (b !== lastBeat) {
        lastBeat = b;
        onBeatRef.current?.(b);
      }
    };

    /** 一帧 = 求值 + 渲染 + 投影 + 浮层同步。rAF 循环与调试钩子共用同一份。 */
    const drawFrame = (): void => {
      stage.update(timer.getElapsed());
      renderer.render(stage.scene, stage.camera);
      // 投影必须在 render 之后: 相机的 matrixWorldInverse 是渲染器在 render 里刷新的
      stage.projectAnchors();
      syncOverlays();
      reportBeat();
    };

    // 调试钩子: 把时间轴理解为恰好 t 秒并画一帧(不依赖 rAF, 后台标签里也能出画面)。
    // 它同样要跑尺寸自检 —— 这个钩子的用途就是"在拿不到渲染帧的环境里复现一帧真实画面",
    // 而真实的一帧本来就包含尺寸维护。
    manualFrameRef.current = (target: number) => {
      timer.update();
      onResize();
      stage.renderAt(target);
      renderer.render(stage.scene, stage.camera);
      stage.projectAnchors();
      syncOverlays();
      reportBeat();
    };

    let raf = 0;
    // 头 40 帧里每 8 帧补一次尺寸自检。
    // 为什么光有 ResizeObserver 不够: 它的回调与 requestAnimationFrame **在同一个渲染
    // 步骤里派发** —— 一旦这个页面拿不到渲染帧(后台标签、被节流的嵌入式视图), 观察器
    // 就一次都不会回调。而"挂载那一帧容器还没有尺寸"是真实会发生的(实测: 容器
    // 1280x720 而画布停在 1x1, 观察器始终不响), 结果就是一屏只有终端 UI、3D 全黑。
    // 自检只在前 2 秒做、每帧 8 次里 1 次, 之后彻底停掉, 不留每帧强制布局的开销。
    let sizeChecks = 0;
    const tick = () => {
      timer.update();
      drawFrame();
      if (sizeChecks < 40) {
        sizeChecks += 1;
        if (sizeChecks % 8 === 0) onResize();
      }
      raf = requestAnimationFrame(tick);
    };
    tick();

    const onResize = () => {
      const w = Math.max(1, mount.clientWidth);
      const h = Math.max(1, mount.clientHeight);
      if (w === viewW && h === viewH) return;
      renderer.setSize(w, h);
      stage.setSize(w, h);
      viewW = w;
      viewH = h;
    };
    window.addEventListener('resize', onResize);
    // **ResizeObserver 是必需的, 不是优化**: 挂载那一帧 mount.clientWidth 完全可能是 0
    // (容器还没被布局出来 / 页面在后台标签里挂载 / 父级有过渡动画), 此时建出来的渲染器
    // 就是 1x1 的, 而只监听 window.resize 的话它永远等不到一次尺寸变化 —— 结果就是一屏
    // 只剩终端 UI、3D 全黑(实测: 画布 1x1、容器 1280x720)。观察器一有真实尺寸就会补上,
    // 顺带也覆盖掉"窗口没变但容器变了"的分栏场景。
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    ro?.observe(mount);

    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(raf);
      stage.dispose();
      stageRef.current = null;
      renderer.dispose();
      // forceContextLoss: 显式告诉驱动"这个上下文不要了", 不等它被 GC 回收
      renderer.forceContextLoss();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
    // 场景随情报(任务)重建; 预览/过场只影响时间轴取法, 不必重建
  }, [intel, missionId, codename]);

  const cards = showCards ? intel.cards : [];

  return (
    <>
      <div ref={mountRef} className="absolute inset-0 z-0" />

      {/* === 目标卡片浮层 ===
          卡片本体是 HTML(终端字体比 3D 文字贴图清楚得多, 换语言也不用重建任何贴图),
          位置由 3D 侧逐帧投影后写进 style.transform。子元素顺序必须与 intel.cards
          一致 —— 循环按下标取 children 直接改 style。
          z-[2]: 压在标记标签之上(卡片比标签更重要)。 */}
      {cards.length > 0 ? (
        <div ref={cardHostRef} className="pointer-events-none absolute inset-0 z-[2] overflow-hidden">
          {cards.map((c, i) => (
            <div
              key={`${c.unitId}-${i}`}
              className="absolute left-0 top-0 opacity-0"
              style={{ transform: 'translate(-50%, -100%)', willChange: 'transform, opacity' }}
            >
              <OverlayItem tone={toneColor(c.tone)} variant="card">
                <div
                  className="crt-panel-head flex items-center justify-between gap-1 px-1.5 py-1"
                  style={{ borderBottomColor: `${toneColor(c.tone)}66` }}
                >
                  <span className="crt-label tracking-[0.2em]" style={{ color: toneColor(c.tone) }}>
                    TGT-{String(i + 1).padStart(2, '0')} · {c.code}
                  </span>
                  <span className="crt-label crt-text--dim">{c.gridRef}</span>
                </div>
                <Blueprint card={c} />
                <div className="space-y-[3px] px-1.5 py-1.5">
                  <div className="crt-data crt-text--hi leading-tight">{c.title}</div>
                  <div className="crt-label leading-snug">{c.typeLabel}</div>
                  <div className="flex items-center justify-between gap-1 pt-[2px]">
                    {/* 敌方卡片的条是"威胁等级"; 我方卡片(要护住的目标)是"关键度" ——
                        同一根条, 语义跟着 tone 走, 免得把"必须护住的运输机"写成威胁。 */}
                    <span className="crt-label">
                      {c.tone === 'friendly' || c.tone === 'player' ? t('stbr.critical') : t('stbr.threat')}
                    </span>
                    <ThreatBar level={c.threat} tone={toneColor(c.tone)} />
                  </div>
                  <div className="crt-label flex items-center justify-between gap-1">
                    <span>{t('stbr.weapon')}</span>
                    <span className="crt-text--hi">{c.weapon}</span>
                  </div>
                  {c.objective ? (
                    <div className="crt-label crt-text--dim leading-snug" style={{ borderTop: '1px solid var(--crt-line)', paddingTop: 3 }}>
                      {c.objective}
                    </div>
                  ) : null}
                </div>
              </OverlayItem>
              {/* 从卡片底边指向地面准星的短引线 */}
              <span
                className="absolute bottom-[-8px] left-1/2 h-[8px] w-px -translate-x-1/2"
                style={{ background: `${toneColor(c.tone)}aa` }}
              />
            </div>
          ))}
        </div>
      ) : null}

      {/* === 敌我标记标签浮层 ===
          位置由 3D 侧逐帧投影驱动, 子元素顺序必须与 intel.units 一致。
          pointer-events-none: 标签绝不能让"点任意处跳过简报"的手势落空。 */}
      <div ref={labelHostRef} className="pointer-events-none absolute inset-0 z-[1] overflow-hidden">
        {intel.units.map((u) => (
          <div
            key={u.id}
            className="absolute left-0 top-0 opacity-0"
            style={{ transform: 'translate(-50%, -50%)', willChange: 'transform, opacity' }}
          >
            <div className="flex flex-col items-center whitespace-nowrap">
              <OverlayItem tone={toneColor(u.tone)} variant="label">{u.label}</OverlayItem>
              <span className="crt-label mt-[1px] leading-none" style={{ color: toneColor(u.tone), opacity: 0.72 }}>
                {en ? u.roleEn : u.roleZh}
                {(u.wave ?? 1) > 1 ? ` · ${t('stbr.est')}` : ''}
              </span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
