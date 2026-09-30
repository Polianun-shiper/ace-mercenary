// ============================================================================
// VibeHub SDK 封装 (P1-1)
// ============================================================================
// 规范要点(https://vibe.lumigrav.space/sdk/v3/llms-full.txt, 唯一真相源):
//   · 必须用 window.VibeHub SDK; 禁止自建后端/数据库/WebSocket
//   · SDK 以**绝对地址**引入(见构建脚本注入的 <script src="https://...">)
//   · VibeHub.init({ work }) 的 work 是**项目 slug**, 不是 /works/ 的作品 ID
//   · token 只驻留当前页面内存, 刷新后需重新授权(不写 localStorage)
//   · 登录/退出/账号状态 UI 必须游戏自己做(SDK 不注入样式)
//   · 实时状态走 P2P(room.sendRealtime), 禁止写库/轮询
//
// 本模块只做**薄封装**: 把 SDK 的异步初始化/登录态变成一个可订阅的对象,
// 让 React 侧用 onAuthChange 驱动 UI。不持有任何游戏状态。

/**
 * 项目 slug —— SDK `init({ work })` 要的是 **slug**, 不是主站 /works/ 或 /play/ 地址里的作品 ID。
 *
 * ⚠ 这里踩过一次"读反了报错"的坑(务必别再来一次): 平台报错会同时给出**期望值**和**当前值**,
 * 「SDK 的 work 参数应填写项目 slug「X」, 不能填写主站 /works/ 或 /play/ 地址中的作品 ID;
 *  当前值为「Y」」—— 句子里带「应填写」的是**正确值**, 带「当前值」的是**错误值**。
 * 当前正确值(平台实测): slug = `P06Yl-WF`, 作品 ID = `1`(填 1 必被拦)。
 *
 * 三级覆盖(便于不改代码就纠正):
 *   ① `window.__VIBE_SLUG`  —— 构建时注入(环境变量 VIBE_SLUG)
 *   ② `localStorage['skybound.vibeSlug']` —— 运行时热改, 刷新即生效:
 *        localStorage.setItem('skybound.vibeSlug','<slug>')
 *   ③ 下面的常量 —— 兜底默认值
 * 前两级若填成**纯数字**(作品 ID 的形态, 例如历史遗留的 '1'), 会被**直接忽略**并落到默认值,
 * 免得旧的 localStorage 值把登录再次卡死。解析结果与来源会写进联机界面的实时 debug 日志
 * (见 net/debug-log.ts), 一眼能看出用的是哪个。
 */
export const DEFAULT_PROJECT_SLUG = 'P06Yl-WF';

/** 纯数字(可含空格) = 作品 ID 形态, 不是 slug → 该值无效。 */
function isLikelyWorkId(v: string): boolean {
  return /^\d+$/.test(v.trim());
}

/** 当前生效的 slug(按上面的优先级解析)。 */
export function resolveProjectSlug(): { slug: string; source: 'window' | 'localStorage' | 'default' } {
  if (typeof window !== 'undefined') {
    const injected = (window as unknown as { __VIBE_SLUG?: string }).__VIBE_SLUG;
    if (injected && injected.trim() && !isLikelyWorkId(injected)) {
      return { slug: injected.trim(), source: 'window' };
    }
    try {
      const ls = window.localStorage.getItem('skybound.vibeSlug');
      if (ls && ls.trim() && !isLikelyWorkId(ls)) return { slug: ls.trim(), source: 'localStorage' };
    } catch { /* 隐私模式等 */ }
  }
  return { slug: DEFAULT_PROJECT_SLUG, source: 'default' };
}


export interface VibeUser {
  id: string;
  name: string | null;
  image: string | null;
}

/** SDK 的最小类型面(只声明我们实际用的部分, 避免依赖外部 .d.ts 文件)。 */
interface SdkRoom {
  readonly roomId: string;
  readonly peerId: string;
  readonly isHost: boolean;
  readonly hostId: string | null;
  readonly data: SdkDataStore;
  readonly state: {
    set<T>(k: string, v: T): unknown;
    get<T>(k: string): T | undefined;
    snapshot(): Record<string, unknown>;
  };
  onMessage(cb: (m: unknown, from: string) => void): unknown;
  onPeer(cb: (e: { type: string; id: string }) => void): unknown;
  send(m: unknown, to?: string): void;
  sendRealtime(m: unknown, to?: string): void;
  peers(): { id: string; open: boolean; latency: number }[];
  networkStats(): unknown;
  announce(md?: Record<string, unknown>): Promise<{ ok: true }>;
  close(): Promise<{ ok: true }>;
  leave(): void;
}

interface SdkDataStore {
  set<T>(k: string, v: T, o?: { ttl?: number }): Promise<{ ok: true }>;
  get<T>(k: string): Promise<T | null>;
  all<T>(): Promise<Record<string, T>>;
}

interface SdkClient {
  readonly work: string;
  readonly save: SdkDataStore;
  readonly global: SdkDataStore;
  readonly user: VibeUser | null;
  readonly rooms: {
    list(): Promise<{ roomId: string; players: number; max?: number; [k: string]: unknown }[]>;
    get(roomId: string): Promise<Record<string, unknown> | null>;
    quickJoin(o?: { filter?: (r: Record<string, unknown>) => boolean }): Promise<string | null>;
  };
  readonly room: { join(roomId: string, o?: Record<string, unknown>): Promise<SdkRoom> };
  login(): Promise<VibeUser>;
  logout(): void;
  isLoggedIn(): boolean;
  onAuthChange(cb: (u: VibeUser | null) => void): () => void;
}

interface SdkGlobal {
  readonly version: string;
  readonly channel: 'stable' | 'beta' | 'unknown';
  init(o: { work: string; apiBase?: string }): Promise<SdkClient>;
}

declare global {
  interface Window {
    VibeHub?: SdkGlobal;
  }
}

/** 联机是否可用(本地双击 / 无网时为 false —— 此时游戏照旧单机运行)。 */
export function sdkPresent(): boolean {
  return typeof window !== 'undefined' && !!window.VibeHub;
}

export function sdkVersion(): string {
  return (typeof window !== 'undefined' && window.VibeHub?.version) || 'n/a';
}

import { logInfo, logOk, logWarn, logError } from './debug-log';

/**
 * VibeHub 客户端门面。
 *
 * 生命周期: init() 只需调用一次(幂等)。登录前 client 已存在, 只是 user 为 null。
 * 所有网络操作(async)都集中在这里, 便于将来替换/测试。
 */
export class VibeHubClient {
  private client: SdkClient | null = null;
  private initPromise: Promise<SdkClient | null> | null = null;
  private authCbs: ((u: VibeUser | null) => void)[] = [];
  private user: VibeUser | null = null;

  /** 初始化(幂等)。SDK 缺失/初始化失败都返回 null, 不抛 —— 单机必须照常能玩。 */
  async init(): Promise<SdkClient | null> {
    if (this.client) return this.client;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const { slug, source } = resolveProjectSlug();
      if (!sdkPresent()) {
        logWarn(`SDK 未加载(本地 file:// 或脚本被拦) — 联机不可用; 单机不受影响`);
        return null;
      }
      logInfo(`SDK v${sdkVersion()} 初始化中 · work(slug)="${slug}" [来源 ${source}]`);
      try {
        const c = await window.VibeHub!.init({ work: slug });
        this.client = c;
        logOk(`SDK 初始化完成 · work=${c.work}`);
        // 订阅登录态: SDK 在过期/退出时回调 null, UI 据此回到登录界面。
        c.onAuthChange((u) => {
          this.user = u;
          logInfo(u ? `登录态: ${u.name ?? u.id}` : '登录态: 未登录(或已过期)');
          for (const cb of this.authCbs) {
            try { cb(u); } catch { /* 单个订阅者出错不影响其它 */ }
          }
        });
        this.user = c.user;
        if (c.user) logOk(`已是登录态: ${c.user.name ?? c.user.id}`);
        return c;
      } catch (err) {
        // ⚠ 最常见的失败就是 work 填了作品 ID 而不是 slug —— 平台会在授权页提示
        //   「应填写项目 slug「…」，当前值为「…」」。这里把原始错误原样记进日志,
        //   联机界面上能直接看到该怎么改(或用 localStorage skybound.vibeSlug 热改)。
        logError(`SDK 初始化失败: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
        logWarn(`提示: work 必须是项目 slug(不是 /works/ 作品 ID)。可在控制台执行 ` +
          `localStorage.setItem('skybound.vibeSlug','<正确 slug>') 后刷新页面。`);
        return null;
      }
    })();
    return this.initPromise;
  }

  get raw(): SdkClient | null {
    return this.client;
  }

  get currentUser(): VibeUser | null {
    return this.user;
  }

  isLoggedIn(): boolean {
    return !!this.client?.isLoggedIn();
  }

  /** 订阅登录态变化; 返回取消订阅函数。 */
  onAuthChange(cb: (u: VibeUser | null) => void): () => void {
    this.authCbs.push(cb);
    cb(this.user);
    return () => {
      const i = this.authCbs.indexOf(cb);
      if (i >= 0) this.authCbs.splice(i, 1);
    };
  }

  /** 打开授权弹窗。必须由用户手势触发(点击), 否则浏览器会拦截。 */
  async login(): Promise<VibeUser | null> {
    logInfo('请求登录(打开授权窗口)…');
    const c = await this.init();
    if (!c) { logError('登录失败: SDK 未就绪'); return null; }
    try {
      const u = await c.login();
      this.user = u;
      logOk(`登录成功: ${u?.name ?? u?.id ?? 'ok'}`);
      return u;
    } catch (err) {
      logError(`登录失败: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
      logWarn('常见原因: ① work 填的是作品 ID 而不是 slug ② 浏览器拦了授权弹窗(需允许弹窗) ③ 未登录主站');
      return null;
    }
  }

  /** 清除本实例内存 token。不删云存档、不退出主站。 */
  logout(): void {
    this.client?.logout();
    this.user = null;
  }
}

/** 全局单例 —— 菜单/引擎共享同一个 SDK 实例(避免重复 init)。 */
let _singleton: VibeHubClient | null = null;
export function getVibe(): VibeHubClient {
  if (!_singleton) _singleton = new VibeHubClient();
  return _singleton;
}
