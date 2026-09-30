'use client';

// ============================================================================
// 剧情简报屏(电影式简报过场 + 剧情中枢菜单)
// ============================================================================
// 本文件提供两个组件, 供 GameApp 在剧情流程里挂接:
//   ① Briefing3D     —— 皇牌空战式简报: 满屏"2D 区域地图 → 缩比网格战场"的六拍
//                        过场(见 briefing-stage.ts) + 叠加终端 UI + 电影式字幕
//                        逐句播报(S01_BRIEF 剧情台词)。
//   ② StoryHubMenu   —— 剧情中枢: 出击前的中转菜单(战斗准备 / 重播简报 /
//                        设置 / 退出任务选择), 视觉语汇与 Menus.tsx 的 MainMenu 一致。
//
// 命名与视觉全部沿用 Menus.tsx 的终端语汇: crt-frame / crt-flicker / crt-panel /
// crt-corner / crt-key / crt-label / crt-data / crt-text--*, 字幕沿用 Hud.tsx 的
// crt-subtitle 族(见 globals.css 的电影字幕段)。
//
// 分工(为什么 3D 编排不在这份文件里):
//   本文件 = **终端 UI 外壳**(抬头条 / 任务书 / 环境读数 / 字幕条 / 跳过与快进 /
//   剧情中枢); 3D 编排在 briefing-stage.ts(纯 three), React 接线在
//   BriefingStage.tsx。这样同一套舞台能被任务简报的预览复用, 而本文件不必再背着
//   900 行场景代码。
//
// 时长与配音的关系: 视觉序列固定 ~19 秒一次播完, 之后**留驻在战术态势图上**, 让
// 剩下的剧情配音逐句播完(18 句约 60 秒)。所以:
//   * 第一次按空格/点击 = 快进到留驻段(不离开简报);
//   * 之后按 = 跳过简报 / 简报结束。
// 这样"想快点看到态势图"和"想跳过整段剧情"这两种意图各有一个明确的动作。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MISSIONS, getMission } from '@/lib/game/missions';
import type { Mission } from '@/lib/game/types';
import { useT } from '@/hooks/use-i18n';
import { getLocale } from '@/lib/game/i18n';
import { zhValue, SKY_ZH, WEATHER_ZH, MAP_ZH } from '@/lib/game/labels-zh';
import { playKey, playConfirm, playBack } from '@/lib/game/ui-sound';
import { deriveBriefingIntel, intelSummary } from '@/lib/game/briefing-intel';
import {
  BEAT_HOLD, BEAT_NAME, BEAT_NAME_ZH, HOLD_T, SEQ_END_T,
} from '@/lib/game/briefing-stage';
import { BriefingStage, type BriefingStageHandle } from './BriefingStage';
// === 简报语音取址 (per user request: 简报/结算配音) ===
// 必须走 assetUrl(): 单文件版把 /audio/radio/*.mp3 内联成 data URI, 直接
// new Audio('/audio/radio/…') 在 file:// 与只上传 index.html 的部署下会 404。
import { assetUrl } from '@/lib/game/asset-url';

// === 终端机箱外发光(呼吸) ===
// 注意: Menus.tsx 里同名常量是该文件的模块私有量(未导出), 无法 import;
// 这里按原值复刻, 保证三个屏的外发光完全一致。
const CRT_PWR_GLOW = '0 0 60px rgba(255,176,0,0.055), 0 0 200px rgba(255,176,0,0.02)';

/** 显像管余晖叠加层(与 MissionSelect / Results 同一份渐变, 保证换屏不跳色) */
const CRT_GLOW_BG =
  'linear-gradient(180deg, rgba(255,176,0,0.05) 0%, rgba(0,0,0,0) 16%, rgba(0,0,0,0) 84%, rgba(255,176,0,0.03) 100%), radial-gradient(120% 80% at 50% 50%, rgba(255,176,0,0.035) 0%, rgba(0,0,0,0) 60%)';

/** 抬头条背景(与 Menus.tsx 的 StatusBar / 抬头条同款 1px 描边 + 暖棕黑渐变) */
const CRT_BAR_BG = 'linear-gradient(180deg, rgba(31,22,8,0.9) 0%, rgba(10,6,1,0.9) 100%)';

// 台词之间的停顿(秒)。0.4s 是广播通话里"该我说话"的自然间隙, 太短会叠字。
const LINE_GAP_S = 0.4;
// 入场后的"防误触"窗口: 从任务选择点进来的那一下点击/回车若穿透到本屏会立刻跳过
// 简报(实机很容易发生)。开场 700ms 内忽略跳过手势。
const SKIP_GUARD_MS = 700;

// ============================================================================
// 剧情台词 API 的防御式接入
// ============================================================================
// radio.ts 会导出 S01_BRIEF / S01_DEBRIEF / storyLineInfo(剧情台词目录)。
// 该 API 与其它剧情改动并行落地, 本文件落地时它在 radio.ts 里可能尚未存在 ——
// 所以这里走"懒加载 + 本地最小接口"的接法:
//   * 模块存在即可 import(模块解析永远是成功的), 缺的只是导出成员;
//   * 运行时成员缺失 -> 自动退化为"单条通用简报行", 简报屏照常可用;
//   * 成员一旦落地, 不需要改本文件就能立刻接上真实台词与配音路径。
export interface StoryLineInfo {
  speaker: string;
  zh: string;
  en: string;
  voiceFile: string;
}

/** radio.ts 里我们真正用到的成员(只声明子集, 不复制它的实现) */
interface StoryRadioApi {
  storyLineInfo?: (ev: string) => StoryLineInfo | undefined;
  /** 各关的简报台词数组按 `<关卡ID大写>_BRIEF` 命名(S01_BRIEF / 将来 S02_BRIEF…) */
  [key: string]: unknown;
}

// 模块级 promise 缓存: 简报可能被反复进出, 不能每次都重新 import 一个模块。
let storyApiPromise: Promise<StoryRadioApi | null> | null = null;

function loadStoryRadio(): Promise<StoryRadioApi | null> {
  if (!storyApiPromise) {
    storyApiPromise = import('@/lib/game/radio')
      .then((mod) => mod as unknown as StoryRadioApi)
      // 模块本身加载失败(极端情况: 打包/网络)也不能把简报屏炸掉 —— 退化为默认行。
      .catch(() => null);
  }
  return storyApiPromise;
}

// ============================================================================
// 台词时序
// ============================================================================
// 本轮没有任何配音文件(public/audio 下只有音乐与音效), voiceFile 指向的路径必然
// 404 —— 所以"播放"是尽力而为: 能响就按音频真实时长, 响不了就按语速估算把字幕
// 挂住。台词永远不会因为缺音频而卡住或抛错。
//
// 语速按脚本字符估: CJK 4.5 字/秒(中文播报语速), 拉丁 14 字/秒; 夹紧 2.5-9 秒
// (太短看不清, 太长像卡死)。它同时是字幕停留时长与整段简报的节奏来源。
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;

function estimateSeconds(text: string): number {
  let cjk = 0;
  let latin = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    if (CJK_CHAR.test(ch)) cjk += 1;
    else latin += 1;
  }
  const sec = cjk / 4.5 + latin / 14;
  return Math.min(9, Math.max(2.5, sec));
}

interface StoryLine {
  speaker: string;
  text: string;
  voiceFile: string;
}

/** 没有剧情台词时的播报人(与原游戏无线电里的预警机呼号一致) */
const FALLBACK_SPEAKER = 'AWACS EAGLE';
/** 折行播报时最多拆成几句(太多句会把简报拖成一部电影) */
const MAX_BRIEF_LINES = 8;
/** 一句话多长还算"能一口气读完"(超过就再切一刀) */
const LINE_SOFT_MAX = 46;
/** 二次切分的软上限 */
const LINE_SOFT_TARGET = 40;

/**
 * 把一段任务书拆成几句, 让没有剧本台词的关卡也能**逐句**播报。
 * 之前这里是把整段 brief 当成一条字幕——s02 的任务书是四句话, 屏幕上就是一大块字,
 * 既读不完也不像简报。现在按句末标点切, 过长的句子再按分号/逗号切一刀。
 */
function splitBrief(text: string): string[] {
  // 用捕获组切分: 结果是 [正文, 标点, 正文, 标点, …] —— 把标点接回前一句
  const raw = text.split(/([。！？!?…]+)/);
  const sentences: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const part = raw[i];
    if (i % 2 === 0) {
      if (part.trim()) sentences.push(part.trim());
    } else if (sentences.length) {
      sentences[sentences.length - 1] += part;
    }
  }
  const out: string[] = [];
  for (const s of sentences) {
    if (s.length <= LINE_SOFT_MAX) { out.push(s); continue; }
    // 过长的句子: 按 分号/逗号 贪心累加到 LINE_SOFT_TARGET 左右
    let buf = '';
    for (const seg of s.match(/[^；;，,]+[；;，,]?/g) ?? [s]) {
      if (buf && (buf + seg).length > LINE_SOFT_TARGET) { out.push(buf); buf = seg; }
      else buf += seg;
    }
    if (buf) out.push(buf);
  }
  return out;
}

/** 简体/英文台词按当前语言取; 空串视为缺失 */
function pickText(info: StoryLineInfo, en: boolean): string {
  const v = en ? info.en : info.zh;
  return typeof v === 'string' ? v : '';
}

/**
 * 组装本次简报要播的台词序列。
 * 关卡台词按 `<关卡ID大写>_BRIEF` 从 radio.ts 取(现在只有 s01 有逐句剧本); 没有剧本
 * 的关卡退化成"把任务书按句拆开逐句念", 于是每一关都有像样的简报旁白。
 */
function buildStoryLines(
  missionId: string,
  mission: Mission | undefined,
  api: StoryRadioApi | null,
  en: boolean,
): StoryLine[] {
  // 关卡 ID 大写即导出名(s01 -> S01_BRIEF)。写成查表而不是写死 s01: 剧情关卡会越加
  // 越多, 每加一关都要回来改这里的判断是最容易忘的那种维护点。
  const maybe = api?.[`${missionId.toUpperCase()}_BRIEF`];
  const events = Array.isArray(maybe) ? (maybe as string[]) : undefined;
  const lookup = api?.storyLineInfo;
  const out: StoryLine[] = [];
  if (events && events.length > 0 && lookup) {
    for (const ev of events) {
      // 逐句包一层 try: 剧情目录里个别事件查不到(索引漂移/新增未登记)时
      // 只丢那一句, 不该整段简报都放不出来。
      try {
        const info = lookup(ev);
        if (!info) continue;
        const text = pickText(info, en);
        if (!text) continue;
        out.push({ speaker: info.speaker || FALLBACK_SPEAKER, text, voiceFile: info.voiceFile || '' });
      } catch {
        /* 单句失败: 跳过 */
      }
    }
  }
  if (out.length === 0) {
    const fallback = mission?.brief
      ?? (en ? 'NO BRIEF ON FILE. STANDBY FOR TASKING.' : '暂无简报文本, 等待任务下达。');
    // 按句拆: 一块"四句话的任务书"当一条字幕是读不完的(见 splitBrief 的注释)
    const parts = splitBrief(fallback).slice(0, MAX_BRIEF_LINES);
    for (const text of (parts.length ? parts : [fallback])) {
      out.push({ speaker: FALLBACK_SPEAKER, text, voiceFile: '' });
    }
  }
  return out;
}

// ============================================================================
// ① Briefing3D —— 3D 任务简报屏
// ============================================================================

/** 块状读数(标签 + 值)。与 Menus.tsx 的同名私有组件同款 —— 那边没导出, 这里复刻。 */
function Readout({ k, v, tone = 'data' }: { k: string; v: string; tone?: 'data' | 'dim' | 'warn' | 'ready' | 'hi' }) {
  const toneClass =
    tone === 'dim' ? 'crt-text--dim'
      : tone === 'warn' ? 'crt-warn'
        : tone === 'ready' ? 'crt-ready'
          : tone === 'hi' ? 'crt-text--hi crt-text--glow' : 'crt-text';
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="crt-label">{k}</span>
      <span className={`crt-data leading-snug ${toneClass}`}>{v}</span>
    </div>
  );
}

export interface Briefing3DProps {
  missionId: string;
  onDone: () => void;
  onSkip: () => void;
  /**
   * 调试/验收用: 挂载后直接把视觉序列跳到这一秒(`/ui-preview?screen=story-brief&t=10`)。
   * headless 截图没有输入能力, 六拍里的中间四拍又各只持续 2-4 秒 —— 没有这个入口
   * 就没法稳定复现"第 4 拍: 进攻箭头"这种画面做视觉回归。
   * 正常运行(GameApp)不传这个参数, 行为完全不受影响。
   */
  debugStartAt?: number;
}

export function Briefing3D({ missionId, onDone, onSkip, debugStartAt }: Briefing3DProps) {
  const t = useT();
  // useT() 订阅了语言变更 -> 语言切换会重渲染本组件, 所以这里直接读 getLocale()
  // 就是最新值(不需要再引 useLocale)。把 locale 放进下面几个 effect 的依赖里,
  // 切语言时字幕会按新语言重新播一遍 —— 这是期望行为。
  const locale = getLocale();
  const en = locale === 'en';

  const mission = useMemo(() => getMission(missionId), [missionId]);

  const wrapRef = useRef<HTMLDivElement>(null);

  // 台词序列 / 播放位置。
  // storyKey = 关卡 + 语言: 两者之一变化时, 下面两个 state 的 key 就对不上了,
  // 于是自动"从头开始"(见 lines / index 的派生)。这样切关卡或切语言是零副作用,
  // 不需要在 effect 里同步重置 state(那会触发一轮级联渲染)。
  const storyKey = `${missionId}|${en ? 'en' : 'zh'}`;
  const [loaded, setLoaded] = useState<{ key: string; lines: StoryLine[] } | null>(null);
  const [pos, setPos] = useState<{ key: string; index: number }>({ key: '', index: 0 });
  // === 配音状态 (per user request: 简报/结算已接入 IndexTTS 英文配音) ===
  // true = 当前这句的 mp3 真的加载成功(字幕会按真实时长同步); false = 无配音,
  // 只显示字幕。底部标签据此显示"配音已接入/无配音", 不再写死成占位。
  const [voiceLive, setVoiceLive] = useState(false);
  // 防误触窗口(见 SKIP_GUARD_MS)
  const enteredAtRef = useRef<number>(Date.now());

  const lines = loaded && loaded.key === storyKey ? loaded.lines : null;
  const index = pos.key === storyKey ? pos.index : 0;
  const total = lines?.length ?? 0;
  // 播完 = 序列已就绪且指针越界(派生量, 不用额外 state 记录)
  const finished = lines !== null && index >= total;
  const current = lines && index < total ? lines[index] : null;
  const shown = Math.min(index + 1, total);

  // -------- 简报情报(任务数据 → 敌我态势) --------
  // 与 3D 舞台、目标卡片、地图投影共用同一份推导结果, 保证"卡片上的格号"和"3D 里
  // 那个标记"说的是同一件事。
  const intel = useMemo(() => deriveBriefingIntel(mission), [mission]);
  const sitrep = useMemo(() => intelSummary(intel), [intel]);

  // -------- 3D 舞台 --------
  // 渲染器与整个场景都由 <BriefingStage> 自己建/自己释放(它内部就是旧版那套
  // "全部在 effect 内创建、在清理里全部释放 + forceContextLoss"的纪律)。本组件只
  // 负责把情报喂给它、把拍号收回来、并且在"快进"时让它 seek。
  const stageApi = useRef<BriefingStageHandle>(null);
  // 当前拍(只有拍号变化时才会更新 —— 整段过场 React 最多重渲染 6 次)
  const [beat, setBeat] = useState(0);
  /**
   * 视觉动画是否已播完。用"键"而不是布尔量: 换关卡 / 换调试跳秒时键对不上, 于是
   * 自动从头开始 —— 这样切关卡是零副作用, **不需要在 effect 里同步 reset state**
   * (effect 体内同步 setState 会触发级联渲染, 也是本文件台词那段的既有规矩)。
   */
  const seqKey = `${missionId}|${debugStartAt ?? ''}`;
  const [doneKey, setDoneKey] = useState('');
  /** 直接跳到留驻段的情况(调试入口) —— 派生量, 不用 state 记 */
  const jumpedToHold = debugStartAt !== undefined && debugStartAt >= HOLD_T;
  const visualDone = doneKey === seqKey || jumpedToHold;
  /** WebGL 不可用时提示玩家"只剩终端"(默认可用, 探测失败才翻) */
  const [glOk, setGlOk] = useState(true);

  // 动画播完 = 固定时长(与 briefing-stage 的 SEQ_END_T 同一个口径)。用定时器而不是
  // 逐帧读时钟: 整段过场只翻一次 state。
  useEffect(() => {
    const id = window.setTimeout(() => setDoneKey(seqKey), SEQ_END_T * 1000);
    return () => window.clearTimeout(id);
  }, [seqKey]);

  // WebGL 可用性探测。状态只影响一行提示文字, 这一帧对不对根本不重要, 所以挪到微任务
  // 里 setState(避免"effect 体内同步 setState"的级联渲染)。
  useEffect(() => {
    let ok = true;
    try {
      const probe = document.createElement('canvas');
      const gl = probe.getContext('webgl2') ?? probe.getContext('webgl');
      ok = !!gl;
      // 探测用的上下文要主动还回去, 否则白占一个(浏览器上限约 16 个)
      (gl as WebGLRenderingContext | null)?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      ok = false;
    }
    queueMicrotask(() => setGlOk(ok));
  }, []);

  // 调试跳转: 只驱动外部系统(seek), 不碰 state —— 拍号由舞台自己在下一帧报回来
  useEffect(() => {
    if (debugStartAt === undefined) return;
    stageApi.current?.seek(debugStartAt);
  }, [debugStartAt]);

  // -------- 台词装配(异步, 不阻塞渲染) --------
  useEffect(() => {
    let cancelled = false;
    enteredAtRef.current = Date.now();
    void (async () => {
      const api = await loadStoryRadio();
      if (cancelled) return;
      setLoaded({ key: storyKey, lines: buildStoryLines(missionId, mission, api, en) });
    })();
    return () => {
      cancelled = true;
    };
  }, [storyKey, missionId, mission, en]);

  // -------- 逐句播放 --------
  // 每句一个定时器: 默认按估算时长(estimateSeconds) + 间隙; 若音频元数据先到,
  // 且真实时长更长, 就用真实时长把定时器重排(有 mp3 时字幕与语音同步)。
  // 音频任何失败都只当"没声音", 绝不影响推进。
  useEffect(() => {
    if (!lines || index >= lines.length) return;
    const line = lines[index];
    const est = estimateSeconds(line.text);
    let timer = 0;
    let audio: HTMLAudioElement | null = null;

    const arm = (seconds: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => setPos((p) => ({ key: storyKey, index: (p.key === storyKey ? p.index : 0) + 1 })),
        (seconds + LINE_GAP_S) * 1000,
      );
    };
    arm(est);

    // 配音已接入(IndexTTS 英文): mp3 存在时按真实时长延长字幕; 缺文件则
    // 回落到 arm() 的估算时长, 只显示字幕(不阻塞流程)。
    if (line.voiceFile) {
      try {
        audio = new Audio(assetUrl(line.voiceFile));
        // === 简报语音音量减半 (per user request) ==============================
        // 本关配音整体抬过 ~3 倍(§230/§232), 简报里的旁白显得太冲 —— 这里单独压到 50%。
        // 只作用于简报界面这一处, 关卡内的电台语音不受影响。
        // per user request: 剧情语音整体放大 —— 这里从 0.5 提回 1.0(元素音量上限)
        audio.volume = 1.0;
        audio.addEventListener('loadedmetadata', () => {
          const d = audio?.duration ?? 0;
          if (Number.isFinite(d) && d > est) arm(d);
          setVoiceLive(true);
        });
        audio.addEventListener('error', () => {
          /* 缺文件: 保持估算时长, 仅显示字幕 */
          setVoiceLive(false);
        });
        const p = audio.play();
        if (p && typeof p.catch === 'function') {
          // 自动播放策略 / 解码失败都只 reject, 不影响字幕
          p.catch(() => undefined);
        }
      } catch {
        audio = null;
        // 只有"构造 Audio 就抛错"这条路会走到这里。不用同步 setState: 在 effect
        // 体内同步改 state 会触发级联渲染(eslint react-hooks/set-state-in-effect),
        // 而这一帧的状态对不对根本不重要(它只影响底部一行提示文字), 挪到微任务里。
        queueMicrotask(() => setVoiceLive(false));
      }
    }

    return () => {
      window.clearTimeout(timer);
      if (audio) {
        // 清理函数绝不允许抛错(卸载路径上抛错会带塌整棵 React 树), 所以整段包起来
        try {
          audio.pause();
          // 去掉 src 再 load(): 让浏览器立刻放弃这次网络请求, 而不是换句后还在后台拉
          audio.removeAttribute('src');
          audio.load();
        } catch {
          /* 忽略: 音频只是旁路 */
        }
      }
    };
  }, [lines, index, storyKey]);

  // 入场聚焦: 满屏简报屏必须让 Space / Enter 立刻可用(不必先点一下)
  useEffect(() => {
    wrapRef.current?.focus();
  }, []);

  /**
   * 快进: 把视觉序列直接跳到留驻段(战术态势图), **不离开简报**。
   * 台词/配音/字幕不动 —— 想听的剧情一句不少, 只是不用等画面演完。
   * 拍号不用在这里手动改: 舞台下一帧就会把 HOLD 报回来(它按自己的时间轴判拍)。
   */
  const doFastForward = useCallback(() => {
    playKey();
    stageApi.current?.seek(HOLD_T);
    setDoneKey(seqKey);
  }, [seqKey]);

  /**
   * 空格 / 回车 / 点空白处: 分两步 ——
   *   ① 画面还没到留驻段 -> 快进(玩家多半只是想快点看到态势图, 不是想走)
   *   ② 已经在留驻段 -> 台词播完=进入(onDone), 没播完=跳过(onSkip)
   * 于是"想快看态势图"和"想跳过整段剧情"各有一个明确的动作, 不会一次点击就
   * 把配音全砍掉。
   */
  const advance = useCallback(() => {
    if (!visualDone) {
      doFastForward();
      return;
    }
    if (finished) {
      playConfirm();
      onDone();
    } else {
      playBack();
      onSkip();
    }
  }, [visualDone, doFastForward, finished, onDone, onSkip]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    // 按钮自己会响应 Enter/Space(冒泡上来会重复触发), 交给按钮处理。
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'BUTTON') return;
    e.preventDefault();
    advance();
  };

  const onBackdropClick = (e: React.MouseEvent) => {
    // 按钮等交互元素带 data-noskip, 由它们自己处理点击
    const el = e.target as HTMLElement | null;
    if (el?.closest?.('[data-noskip]')) return;
    if (Date.now() - enteredAtRef.current < SKIP_GUARD_MS) return;
    advance();
  };

  const codename = mission?.codename ?? '----';
  const title = mission?.title ?? (en ? 'NO DATA' : '暂无数据');

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onClick={onBackdropClick}
      className="crt-frame crt-flicker relative h-full w-full select-none overflow-hidden crt-font focus:outline-none"
      style={{ background: 'var(--crt-bg)' }}
    >
      {/* === 3D 舞台 + 目标卡片 + 标记标签 ===
          整个"2D 地图 → 缩比网格战场"的六拍过场在这里; 卡片与标签是 HTML 浮层,
          位置由 3D 侧逐帧投影驱动(见 BriefingStage.tsx)。
          z 序: 画布 0 < 标签 1 < 卡片 2 < 显像管余晖 10 < 终端 UI 20 —— 于是浮层
          既清楚, 又和画布一样吃到 CRT 的色偏与扫描线。 */}
      <BriefingStage
        ref={stageApi}
        intel={intel}
        mode="sequence"
        en={en}
        missionId={missionId}
        codename={codename}
        onBeat={setBeat}
      />

      {/* 显像管余晖 */}
      <div className="pointer-events-none absolute inset-0 z-10" style={{ backgroundImage: CRT_GLOW_BG, boxShadow: CRT_PWR_GLOW }} />

      <div className="relative z-20 flex h-full w-full flex-col">
        {/* 终端抬头条 */}
        <div
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-2.5 py-1.5"
          style={{ borderColor: 'var(--crt-line-strong)', background: CRT_BAR_BG }}
        >
          <button data-noskip="1" type="button" onClick={() => { playBack(); onSkip(); }} className="crt-key shrink-0 px-2.5 py-1 text-[10px]">
            ◀ {t('stbr.skip')}
          </button>
          <span className="crt-data crt-text--hi crt-text--glow tracking-[0.3em]">{t('br.title')}</span>
          <span className="crt-label hidden sm:inline">· TAC-OS 3.11 · STORY BRIEF</span>
          {/* 拍读数: 只在拍号变化时更新(整段过场最多 6 次) */}
          <span className="crt-label flex items-center gap-1.5">
            <span className="crt-text--hi">{t('stbr.beat')}</span>
            <span className="crt-text--hi crt-text--glow">
              {beat === BEAT_HOLD ? BEAT_NAME[BEAT_HOLD] : BEAT_NAME[beat]}
            </span>
            <span className="crt-text--dim">
              {beat === BEAT_HOLD
                ? '—'
                : `${String(Math.min(beat + 1, 6)).padStart(2, '0')}/06`}
            </span>
            <span className="hidden md:inline crt-text--dim">
              {beat === BEAT_HOLD ? BEAT_NAME_ZH[BEAT_HOLD] : BEAT_NAME_ZH[beat]}
            </span>
          </span>
          <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="crt-label crt-warn">CLASS ■ TOP SECRET</span>
            <span className="crt-label hidden sm:inline">{`${codename} · ${missionId.toUpperCase()}`}</span>
            {total > 1 ? (
              <span className="crt-data crt-text--hi crt-text--glow">{`${shown} / ${total}`}</span>
            ) : null}
          </span>
        </div>

        {/* 简报正文/数据: 左任务书 + 右环境数据, 中间留空给 3D */}
        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          <div className="flex min-h-full flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
            {/* 左: 任务书 */}
            <div className="crt-panel crt-corner w-full lg:max-w-[430px]">
              <div className="crt-panel-head flex items-center justify-between gap-2 px-2.5 py-1.5">
                <span className="crt-label crt-text--hi tracking-[0.26em]">{en ? 'TASKING' : '任务书'}</span>
                <span className="crt-label truncate">OPORD · 1/1</span>
              </div>
              <div className="p-2.5">
                <div className="crt-label mb-0.5">{en ? 'CODE NAME' : '行动代号'}</div>
                <div className="crt-data crt-text--hi crt-text--glow text-lg leading-tight tracking-[0.08em]">{codename}</div>
                <div className="crt-data crt-text--hi mt-1 text-[0.8125rem] leading-snug">{title}</div>

                <span
                  className="mt-2 mb-1.5 block h-[6px] w-full"
                  style={{
                    backgroundImage:
                      'repeating-linear-gradient(90deg, var(--crt-amber-deep) 0 1px, transparent 1px 9px), repeating-linear-gradient(90deg, var(--crt-amber) 0 1px, transparent 1px 45px)',
                    opacity: 0.75,
                  }}
                />

                <div className="crt-label mb-1">{en ? 'SITUATION' : '战况说明'}</div>
                <p className="crt-data crt-text--hi text-[0.8125rem] leading-relaxed">{mission?.brief ?? '--'}</p>

                <div className="crt-label mb-1 mt-3 tracking-[0.24em]">{t('br.objectives')}</div>
                <ul className="space-y-1">
                  {(mission?.objectives ?? []).map((o) => (
                    <li key={o.id} className="crt-data flex items-start gap-2">
                      <span className="crt-text--deep shrink-0">▸</span>
                      <span className="crt-text--hi">
                        {o.label}
                        {o.count ? ` (${o.count})` : ''}
                        {o.time ? ` (${o.time}s)` : ''}
                      </span>
                    </li>
                  ))}
                  {(mission?.objectives ?? []).length === 0 ? (
                    <li className="crt-data crt-text--dim">{en ? 'NO OBJECTIVES ON FILE' : '暂无目标'}</li>
                  ) : null}
                </ul>
              </div>
            </div>

            {/* 右: 环境 / 情报读数 */}
            <div className="crt-panel crt-corner w-full lg:max-w-[320px]">
              <div className="crt-panel-head flex items-center justify-between gap-2 px-2.5 py-1.5">
                <span className="crt-label crt-text--hi tracking-[0.26em]">{t('br.environment')}</span>
                <span className="crt-label truncate">INTEL</span>
              </div>
              <div className="p-2.5">
                <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                  <Readout k="SKY" v={mission ? zhValue(SKY_ZH, mission.sky.toUpperCase()) : '--'} />
                  <Readout k="WX" v={mission ? zhValue(WEATHER_ZH, (mission.weather ?? 'clear').toUpperCase()) : '--'} />
                  <Readout k="MAP" v={mission ? zhValue(MAP_ZH, (mission.map ?? 'ocean').toUpperCase()) : '--'} />
                  <Readout k="LIMIT" v={mission?.timeLimit ? `${Math.round(mission.timeLimit / 60)} MIN` : '∞'} />
                  <Readout k={en ? 'REWARD' : '奖励'} v={mission?.reward ?? '--'} tone="hi" />
                  {/* 单位数用**推导出的情报图**里的接触数, 不用 mission.spawns.length ——
                      s01 的 spawns 是空数组(敌人由剧情控制器动态刷出), 拿它显示会是个
                      和右边态势读数(友军/敌军/目标)自相矛盾的 0。 */}
                  <Readout k="UNITS" v={t('ms.units', { n: intel.units.length })} />
                </div>

                <span
                  className="mt-2 mb-1.5 block h-[6px] w-full"
                  style={{
                    backgroundImage:
                      'repeating-linear-gradient(90deg, var(--crt-amber-deep) 0 1px, transparent 1px 9px), repeating-linear-gradient(90deg, var(--crt-amber) 0 1px, transparent 1px 45px)',
                    opacity: 0.75,
                  }}
                />

                <div className="crt-label mb-1">{en ? 'OPFOR' : '敌情'}</div>
                {/* 态势读数: 数字直接来自推导出的情报图, 不是写死的文案 ——
                    所以它和 3D 里那些标记、以及上面那几张卡片, 说的是同一件事。 */}
                <div className="flex items-center justify-between gap-2">
                  <span className="crt-label">{t('stbr.friendly')}</span>
                  <span className="crt-data crt-ready">{String(sitrep.friendly).padStart(2, '0')}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="crt-label">{t('stbr.enemy')}</span>
                  <span className="crt-data crt-warn">{String(sitrep.enemy).padStart(2, '0')}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="crt-label">{t('stbr.targets')}</span>
                  <span className="crt-data crt-warn">{String(sitrep.targets).padStart(2, '0')}</span>
                </div>
                <div className="crt-data crt-text--dim mt-1.5 leading-relaxed">{t('stbr.legend')}</div>
                {!glOk ? <div className="crt-data crt-warn mt-1">{t('stbr.nogl')}</div> : null}
                <span className="tp-hazard mt-2 block h-2.5 opacity-60" />
              </div>
            </div>
          </div>
        </div>

        {/* 底部字幕条 + 控制 */}
        <div
          className="shrink-0 border-t px-3 pb-2 pt-2"
          style={{ borderColor: 'var(--crt-line-strong)', background: 'linear-gradient(180deg, rgba(10,6,1,0.94) 0%, rgba(24,16,5,0.97) 100%)' }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="crt-label flex flex-wrap items-center gap-x-2">
              <span className="crt-text--hi">{`▶ ${en ? 'BRIEFING' : '简报'}`}</span>
              {total > 1 ? <span>{`${shown} / ${total}`}</span> : <span className="crt-text--dim">{en ? 'SINGLE LINE' : '单条'}</span>}
              {visualDone ? <span className="crt-text--hi">{en ? '■ VISUAL DONE' : '■ 动画完毕'}</span> : null}
              {finished ? <span className="crt-text--hi">{en ? '■ COMPLETE' : '■ 播报完毕'}</span> : null}
            </span>
            <span className="flex flex-wrap items-center gap-2">
              {/* 快进: 动画没到留驻段之前, 它比"跳过简报"更可能是玩家想要的 */}
              {!visualDone ? (
                <button
                  data-noskip="1"
                  type="button"
                  onClick={doFastForward}
                  className="crt-key px-3 py-2 text-[10px] tracking-[0.2em]"
                >
                  {t('stbr.ffwd')}
                </button>
              ) : null}
              <button
                data-noskip="1"
                type="button"
                onClick={() => { playBack(); onSkip(); }}
                className="crt-key px-3 py-2 text-[10px] tracking-[0.2em]"
              >
                {t('stbr.skip')}
              </button>
              {finished ? (
                <button
                  data-noskip="1"
                  type="button"
                  onClick={() => { playConfirm(); onDone(); }}
                  className="crt-key crt-corner px-4 py-2 text-[0.75rem] font-bold tracking-[0.28em] hover:border-[var(--crt-amber-hi)] hover:text-[color:var(--crt-amber-hi)]"
                >
                  {t('stbr.proceed')}
                </button>
              ) : null}
            </span>
          </div>

          {/* 电影式字幕(与 Hud.tsx 的无线电字幕同一套类) */}
          <div className="mt-2 flex min-h-[2.6rem] items-center justify-center text-center">
            {current ? (
              <div className="crt-subtitle max-w-[86vw]" key={`${index}-${current.speaker}`}>
                <span className="crt-subtitle__spk">{`[${current.speaker}]`}</span>
                <span>{current.text}</span>
              </div>
            ) : (
              <div className="crt-subtitle crt-subtitle--accent">
                {en ? 'STAND BY · BRIEFING COMPLETE' : '待命 · 简报结束'}
              </div>
            )}
          </div>
        </div>

        {/* 底部提示行 */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-1.5" style={{ borderColor: 'var(--crt-line)' }}>
          {visualDone ? (
            <>
              <span className="crt-label">SPACE / ENTER {finished ? (en ? 'PROCEED' : '进入') : (en ? 'SKIP' : '跳过')}</span>
              <span className="crt-label">{t('stbr.hold')}</span>
            </>
          ) : (
            <>
              <span className="crt-label">SPACE / ENTER {en ? 'FAST-FORWARD' : '快进'}</span>
              <span className="crt-label">CLICK {en ? 'ANYWHERE TO FAST-FORWARD' : '任意处快进'}</span>
            </>
          )}
          <span className="crt-label crt-text--dim">
            {voiceLive
              ? (en ? 'VOICE FEED LIVE · SUBTITLE SYNCED' : '配音已接入 · 字幕同步')
              : (en ? 'VOICE FEED OFFLINE · TEXT ONLY' : '无配音 · 仅字幕')}
          </span>
          <span className="tp-hazard h-2.5 w-14" />
          <span className="crt-label ml-auto whitespace-nowrap">SN 007-1986-A · MADE IN THE BUNKER</span>
        </div>
      </div>

      {/* ===== CRT 叠加层(纯装饰, 不接收指针事件) ===== */}
      <div className="crt-scanlines pointer-events-none absolute inset-0 z-40 opacity-80" />
      <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden">
        <div className="tp-tracking h-[16%] w-full" />
      </div>
      <div className="crt-vignette pointer-events-none absolute inset-0 z-40" />
    </div>
  );
}

// ============================================================================
// ② StoryHubMenu —— 剧情中枢菜单
// ============================================================================
// 只有四个入口(与需求一致, 不多不少): 战斗准备 / 重播简报 / 调整设置 / 退出。
// 版式沿用 MainMenu 的"左列表 + 右详情"分栏: 左边是可键盘导航的入口列表
// (role=listbox, ↑↓/Home/End/Enter, 鼠标悬停即选中), 右边是当前选中项的说明 +
// 本关代号/目标摘要。键位手感与 MainMenu 的 MODES 列表保持一致(含 UI 音效)。

type HubEntryKey = 'sortie' | 'prep' | 'replay' | 'settings' | 'exit';

interface HubEntry {
  key: HubEntryKey;
  glyph: string;
  label: string;
  sub: string;
  desc: string;
  run: () => void;
}

export interface StoryHubMenuProps {
  missionId: string;
  /** 出击: 用当前挂载直接进本关(需求里列的四个入口之外必须有的"开始"动作) */
  onSortie: () => void;
  onPrep: () => void;
  onExit: () => void;
  onReplayBriefing: () => void;
  onSettings: () => void;
}

export function StoryHubMenu({ missionId, onSortie, onPrep, onExit, onReplayBriefing, onSettings }: StoryHubMenuProps) {
  const t = useT();
  const en = getLocale() === 'en';
  const mission = useMemo(() => getMission(missionId), [missionId]);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 入口顺序: 出击放第一位(它是这一屏唯一"开始"的动作), 后面四个是用户点名的入口
  const ENTRIES = useMemo<HubEntry[]>(() => [
    {
      key: 'sortie',
      glyph: '★',
      label: en ? 'SORTIE' : '出击',
      sub: 'LAUNCH',
      desc: en
        ? 'LAUNCH THIS SORTIE WITH THE CURRENT LOADOUT.'
        : '以当前机型与挂载出击, 进入本关。',
      run: onSortie,
    },
    {
      key: 'prep',
      glyph: '▶',
      label: en ? 'BATTLE PREP' : '战斗准备',
      sub: 'LOADOUT',
      desc: en
        ? 'PICK AIRFRAME, ORDNANCE AND WINGMAN BEFORE LAUNCH.'
        : '出击前选择机型、挂载武器与僚机配置。',
      run: onPrep,
    },
    {
      key: 'replay',
      glyph: '⟲',
      label: en ? 'REPLAY BRIEFING' : '重播简报',
      sub: 'BRIEFING',
      desc: en
        ? 'RERUN THE 3D BRIEFING AND NARRATION FOR THIS SORTIE.'
        : '重看本关的 3D 简报与台词播报。',
      run: onReplayBriefing,
    },
    {
      key: 'settings',
      glyph: '⚙',
      label: en ? 'SETTINGS' : '调整设置',
      sub: 'SYSTEM',
      desc: en
        ? 'VOLUME, GRAPHICS, KEYBINDS AND LANGUAGE.'
        : '音量、画质、按键绑定与语言。',
      run: onSettings,
    },
    {
      key: 'exit',
      glyph: '⏏',
      label: en ? 'EXIT TO MISSION SELECT' : '退出到任务选择',
      sub: 'BACK',
      desc: en
        ? 'LEAVE THE STORY HUB AND RETURN TO THE SORTIE INDEX.'
        : '离开剧情中枢, 回到任务选择界面。',
      run: onExit,
    },
  ], [en, onSortie, onPrep, onReplayBriefing, onSettings, onExit]);

  const [sel, setSel] = useState(0);
  const entry = ENTRIES[Math.min(sel, ENTRIES.length - 1)];

  // 入场聚焦: 与 MainMenu 一样靠容器接键, 但这里主动聚焦 —— 剧情中枢是"进来就要
  // 用 ↑↓ 选"的屏, 不该要求玩家先点一下。
  useEffect(() => {
    wrapRef.current?.focus();
  }, []);

  // 键位与 MainMenu 的 MODES 列表一致: ↑↓ 循环 / Home / End / Enter / Space 执行
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      playKey();
      setSel((i) => (i + step + ENTRIES.length) % ENTRIES.length);
      return;
    }
    if (e.key === 'Home') { e.preventDefault(); playKey(); setSel(0); return; }
    if (e.key === 'End') { e.preventDefault(); playKey(); setSel(ENTRIES.length - 1); return; }
    if (e.key === 'Enter' || e.key === ' ') {
      // 焦点在按钮上时由按钮自己处理, 避免一次按键执行两遍
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'BUTTON') return;
      e.preventDefault();
      playConfirm();
      ENTRIES[sel].run();
    }
  };

  const codename = mission?.codename ?? '----';
  const title = mission?.title ?? (en ? 'NO DATA' : '暂无数据');
  const objCount = mission?.objectives.length ?? 0;
  const objSummary = mission && objCount > 0
    ? `${t('ms.objectives', { n: objCount })} · ${mission.objectives.map((o) => o.label).join(' / ')}`
    : (en ? 'NO OBJECTIVES ON FILE' : '暂无目标');

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="crt-frame crt-flicker relative h-full w-full select-none overflow-hidden crt-font focus:outline-none"
      style={{ background: 'var(--crt-bg)' }}
    >
      {/* 显像管余晖 */}
      <div className="pointer-events-none absolute inset-0" style={{ backgroundImage: CRT_GLOW_BG, boxShadow: CRT_PWR_GLOW }} />

      <div className="relative z-10 flex h-full w-full flex-col">
        {/* 终端抬头条 */}
        <div
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-2.5 py-1.5"
          style={{ borderColor: 'var(--crt-line-strong)', background: CRT_BAR_BG }}
        >
          <button type="button" onClick={() => { playBack(); onExit(); }} className="crt-key shrink-0 px-2.5 py-1 text-[10px]">
            ◀ {t('ms.back')}
          </button>
          <span className="crt-data crt-text--hi crt-text--glow tracking-[0.3em]">{en ? 'STORY HUB' : '剧情中枢'}</span>
          <span className="crt-label hidden sm:inline">· TAC-OS 3.11 · DEBRIEF ROOM</span>
          <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="crt-label crt-warn">CLASS ■ TOP SECRET</span>
            <span className="flex items-center gap-1.5">
              <span className="tp-led animate-tp-breathe h-2 w-2" style={{ color: 'var(--crt-amber)' }} />
              <span className="crt-label">{t('ms.countOps', { n: MISSIONS.length })}</span>
            </span>
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          {/* min-h-full: 内容不满一屏时面板撑满(与 MainMenu 的四区布局一致),
              内容超出时自然变高并被外层 overflow-y-auto 滚动 —— 用 min-h 而不是 h。 */}
          <div className="mx-auto grid min-h-full w-full max-w-4xl gap-2 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
            {/* 入口列表 */}
            <div className="crt-panel crt-corner flex min-h-0 flex-col">
              <div className="crt-panel-head flex items-center justify-between gap-2 px-2.5 py-1.5">
                <span className="crt-label crt-text--hi tracking-[0.26em]">{en ? 'OPTIONS' : '选项'}</span>
                <span className="crt-label">↑↓ / ENTER</span>
              </div>
              <div className="p-1.5" role="listbox" aria-label={en ? 'Story hub options' : '剧情中枢选项'}>
                {ENTRIES.map((item, i) => {
                  const selected = i === sel;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onMouseEnter={() => { setSel(i); playKey(); }}
                      onFocus={() => setSel(i)}
                      onClick={() => { playConfirm(); setSel(i); item.run(); }}
                      className={`relative flex w-full items-center gap-2 px-2 py-[7px] text-left transition-colors ${selected ? 'crt-invert' : ''}`}
                    >
                      <span className={`w-4 shrink-0 text-center text-[11px] ${selected ? '' : 'crt-text--dim'}`}>{item.glyph}</span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className={`crt-data truncate text-[13px] tracking-[0.12em] ${selected ? 'font-bold' : 'crt-text--dim'}`}>{item.label}</span>
                        <span className={`crt-label truncate ${selected ? '' : 'crt-text--dim'}`}>{item.sub}</span>
                      </span>
                      <span className={`crt-label shrink-0 ${selected ? '' : 'opacity-0'}`}>▶</span>
                    </button>
                  );
                })}
              </div>
              <div className="mt-auto shrink-0 border-t p-2" style={{ borderColor: 'var(--crt-line)' }}>
                <div className="crt-label mb-1">LOCAL RECORD</div>
                <div className="crt-data crt-text--dim truncate text-[10px]">SORTIE · {missionId.toUpperCase()}</div>
                <div className="crt-data crt-text--dim truncate text-[10px]">AIRFRAME · {en ? 'EDIT IN BATTLE PREP' : '在战斗准备中调整'}</div>
                <div className="crt-data crt-text--dim truncate text-[10px]">TAPE 1 · SIDE A · STORY</div>
              </div>
            </div>

            {/* 详情 */}
            <div className="crt-panel crt-corner flex min-h-0 flex-col">
              <div className="crt-panel-head flex items-center justify-between gap-2 px-2.5 py-1.5">
                <span className="crt-label crt-text--hi tracking-[0.26em]">{en ? 'DETAIL' : '详情'}</span>
                <span className="crt-label truncate">{entry.sub}</span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
                {/* 本关抬头: 代号 + 标题 + 一行目标摘要 */}
                <div className="crt-label mb-0.5">{en ? 'CODE NAME' : '行动代号'}</div>
                <div className="crt-data crt-text--hi crt-text--glow text-[1.0625rem] leading-tight tracking-[0.08em]">{codename}</div>
                <div className="crt-data crt-text--hi mt-1 text-[0.8125rem] leading-snug">{title}</div>
                <div className="crt-data crt-text--dim mt-1 truncate text-[11px]">{objSummary}</div>

                <span
                  className="mt-2 mb-1.5 block h-[6px] w-full"
                  style={{
                    backgroundImage:
                      'repeating-linear-gradient(90deg, var(--crt-amber-deep) 0 1px, transparent 1px 9px), repeating-linear-gradient(90deg, var(--crt-amber) 0 1px, transparent 1px 45px)',
                    opacity: 0.75,
                  }}
                />

                <div className="crt-label mb-1">{entry.label}</div>
                <div className="crt-data crt-text--hi text-[0.8125rem] leading-relaxed">{entry.desc}</div>

                <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
                  <Readout k="SKY" v={mission ? zhValue(SKY_ZH, mission.sky.toUpperCase()) : '--'} />
                  <Readout k="WX" v={mission ? zhValue(WEATHER_ZH, (mission.weather ?? 'clear').toUpperCase()) : '--'} />
                  <Readout k="MAP" v={mission ? zhValue(MAP_ZH, (mission.map ?? 'ocean').toUpperCase()) : '--'} />
                  <Readout k={en ? 'REWARD' : '奖励'} v={mission?.reward ?? '--'} tone="hi" />
                </div>

                <div className="crt-label mt-3 leading-relaxed">
                  {en
                    ? 'ALL CHANGES PERSIST TO LOCAL STORAGE. MISSION START APPLIES THE LOADOUT.'
                    : '所有改动写入本地存储, 出击时按当前配置装载。'}
                </div>
              </div>
              <div className="crt-label crt-text--dim shrink-0 border-t px-2.5 py-1.5" style={{ borderColor: 'var(--crt-line)' }}>
                {`SN 007-1986-A · HUB / ${entry.sub}`}
              </div>
            </div>
          </div>
        </div>

        {/* 底部提示行 */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-1.5" style={{ borderColor: 'var(--crt-line)' }}>
          <span className="crt-label">↑↓ NAV</span>
          <span className="crt-label">ENTER EXEC</span>
          <span className="crt-label">{en ? 'CLICK SELECT' : '点击选择'}</span>
          <span className="crt-warn crt-label">⚠ LIVE ORDNANCE</span>
          <span className="tp-hazard h-2.5 w-14" />
          <span className="crt-label ml-auto hidden truncate sm:inline">{codename}</span>
          <span className="tp-barcode hidden h-5 w-24 sm:block" />
        </div>
      </div>

      {/* ===== CRT 叠加层(纯装饰) ===== */}
      <div className="crt-scanlines pointer-events-none absolute inset-0 z-40 opacity-80" />
      <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden">
        <div className="tp-tracking h-[16%] w-full" />
      </div>
      <div className="crt-vignette pointer-events-none absolute inset-0 z-40" />
    </div>
  );
}
