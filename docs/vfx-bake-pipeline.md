# 爆炸特效烘焙 → 游戏 导入工作流

> 目标: 用 Blender 的气体/火焰仿真烘出**真正的**爆炸序列帧, 替换游戏里原来那套
> "柔边圆点"特效, 并且"在实时关卡里看到的和 Blender 里渲的一致" ——
> 图集不错位、不串通道、不静默失效、不撑爆单文件产物。

本文是**面向使用者**的流程说明; Blender 侧的脚本约定与踩坑记录在
`blender/vfx/README.md`, 那里是唯一真值。

---

## 0. 一句话流程

```
bash blender/vfx/bake-all.sh                    # 烘(两个预设约 80~90 分钟)
  → node scripts/vfx-atlas-pack.mjs --all       # 打包图集 + 自动写 fx-tune.json
  → 刷新页面即生效(无需改代码、无需重新构建)
```

改观感: 调 `blender/vfx/vfx_lib.py` 的 `PRESETS` → 重跑(只改材质参数时用
`30_render.py --passes fire` 可跳过仿真重烘)。

---

## 1. 为什么现在是"拉跨"的(先说清起点)

游戏里爆炸其实有**三条**路径, 当前生效的恰恰是最弱的一条:

| 路径 | 代码 | 状态 |
|---|---|---|
| `WeaponSystem` 原生爆炸(6 层 mesh + Canvas 2D 程序化贴图) | `src/lib/game/weapons.ts:2004` | 被替换层挡住, 不走 |
| 图集路径(`explosion-fire/smoke.png`, 程序化生成) | `weapons.ts:1023-1130` | **死的** —— `onFxOverride` 永远先返回 true |
| 内建 FX 预设(共享"柔边圆点"渐变贴图) | `src/lib/fx/fx-presets.ts` | **当前实际在跑** |

所以每次爆炸画出来的是一堆**柔边圆点**在飞, 没有任何真实火焰/烟雾形貌。

结论: 缺的不是接入管线(管线早就通了), 缺的是**真正烘出来的序列帧图集**。

---

## 2. 为什么要"打包器"这一层

和 `docs/blender-pipeline.md` 的 `blender-pack.mjs` 同一个理由: Blender 直接吐
"游戏格式"看着省事, 但会把约定散进场景设置里 —— 而这类错误的表现是
**画面"看着怪但说不出哪错"**(火球发灰? 烟带黑边? 火半截埋进地里?), 排查成本极高。

所以约定集中在 `scripts/vfx-atlas-pack.mjs` **一处**校验, 违规**硬失败且不写任何文件**:

| 关注点 | 出错时的表现(若不校验) |
|---|---|
| `view_transform` 必须是 Standard | AgX/Filmic 把火球去饱和压暗, 8bit 落盘后不可逆 |
| 相机必须是正交 | 透视视差 → 贴到 billboard 上是错的 |
| 地面预设取景必须"内容贴帧底边" | 游戏侧 `sheetFootLift` 抬升后火球浮空或埋地 |
| 火趟 alpha 必须改写成 `max(R,G,B)` | 纯自发光体积的 alpha≈0 → **游戏里火完全不可见** |
| 烟趟必须是直通 alpha, 全透明像素 RGB=0 | 预乘没处理干净 → 烟带黑边 |
| 地面预设 bbox 底边必须贴地(z≈0) | 抬升量按 `size/2` 算, 不贴地就对不上 |
| 内容不能是空的 / 火不能被截成一片白 | 烘糊了却"看起来有文件", 最坏的一种失败 |

---

## 3. 游戏侧怎么接入(已就绪, 无需再改)

### 3.1 资产怎么找

图集放 `public/textures/vfx/<preset>-{fire,smoke}.png`, 在 `asset-library.json` 里
登记为 `copy=true / external=true` → 单文件构建时随行拷到
`<out>/assets/textures/vfx/`, **不进 HTML**(所以不占那 100MB 上限)。

资产 JSON 用 `sheet.url` 指外置 PNG:

```json
"sheet": { "url": "/textures/vfx/ground-fire.png", "cols": 7, "rows": 7, "frames": 48,
           "key": "ground-fire" }
```

### 3.2 为什么必须走 url 而不是内联 dataUrl

`FxSystem.decodeSheet` 原本是 `sheet.dataUrl ?? sheet.url` **直接**丢给
`TextureLoader`。开发服务器下根相对路径没问题, 但单文件构建里资产在
`<out>/assets/...` → 会 404。仓库已有 `src/lib/game/asset-url.ts` 负责这件事
(`weapons.ts:1028` 加载旧图集时就在用), 所以给 `FxSystem` 开了一个注入点:

```ts
// src/lib/fx/fx-core.ts
export type SheetUrlResolver = (url: string) => string;
constructor(scene, capacity, private resolveSheetUrl: SheetUrlResolver = (u) => u) {}

// src/lib/game/fx-battle.ts
this.system = new FxSystem(scene, 2048, assetUrl);
```

用注入而不是让 `fx-core` 直接 `import asset-url`, 是为了不让 `src/lib/fx/`
反向依赖 `src/lib/game/`(层次倒挂)。编辑器侧不传即恒等。

**不要**把图集 base64 内联进 `fx-tune.json`: 单文件产物已贴 100MB 上限
(`docs/phase-d-e-decisions.md`), 一个 1792² 图集内联进去就直接超。

### 3.3 槽位怎么分发

`public/config/fx-tune.json` 由打包器写出 `slots.ground` / `slots.air`,
`engine.ts:6780` 读到槽位就 `new FxBattleLayer(scene)` 并 `init(doc)`;
每次爆炸按**命中点离地高度**(>25m = 空中槽)分发(`engine.ts:6583-6593`)。
无 fx-tune / 无槽位 / 解码失败 → 完全回落到内建预设, 零回归。

### 3.4 一个顺带修掉的渲染顺序问题

火(加性)与烟(normal)是两个粒子池、同位置、都 `depthWrite:false` →
three 的透明排序对它俩是平局, 只能靠 `renderOrder` 定序, 否则火球会被烟糊住
且可能闪烁。已在 `makePool` 里按混合模式给了 `renderOrder = additive ? 2 : 1`。

---

## 4. 验证(每次重新烘完跑一遍)

```bash
# 1) 契约 + 统计(不落盘): 空图集 / 火被截成一片白 / 烟带黑边 / 帧数缺失
node scripts/vfx-atlas-pack.mjs --all --dry-run

# 2) 接片目检(带帧号; 火趟按加性合成, 和游戏一致)
#    blender/vfx/out/<preset>/sheet_{fire,smoke}.png

# 3) 游戏内 A/B(真·WebGL + 定点截图, 新图集 vs 原生逃生阀)
node scripts/serve-test.mjs &           # 起 dist-test/http 服务(127.0.0.1:8898)
node scripts/fx-ab-shot.mjs --both

# 4) 回归: 替换后应当**变便宜**(每类特效只剩 1~2 个 draw call)
node scripts/perf-hitch-probe.mjs http://127.0.0.1:8898/
```

`fx-ab-shot.mjs` 做的事: 固定天气(`localStorage.skybound.weatherOverride`)→ 显式要新式
(`skybound.fxReplacement='new'`)→ 进关卡 → `__freezeCam(true)` + 定点相机 → 用
`window.__engine.weapons.spawnExplosion(pos, scale)` 在指定的离地高度触发地面/空中
爆炸 → 在 t=0.1/0.3/0.7/1.4s 逐帧截图 → 再跑一遍(运行时把 `fxLegacyMode` 置 true, 走
老 sprite, weapons 自带的 `explosion-fire/smoke.png` 图集)作为基线 → 任何
`__glErrors`/`__jsErrors` 都会让脚本非 0 退出。
产物在 `.shots/fx-ab/{baked,legacy}/`。

> 天气必须固定: 它是随机的, A/B 不固定就没法对比。
>
> **爆炸视觉默认是"老 sprite"**(per user request: 新特效用不了先切回来): 新式序列帧替换层
> 默认**不加载**, 连那 8 张 1792² 图集都不解码(省百 MB 显存)。要新式: 控制台 `fxsrc new`
> (或 `skybound.fxReplacement='new'`)**并重载关卡**, 因为新式层是在 `loadSky` 里建的。
> `fxsrc` 不带参数可查当前来源; `fxsrc old` / `fxsrc auto` 切回老 sprite。

---

## 5. 已知取舍

- **入游戏图集默认 256px/格**(渲染源保留 512px)。512px/格 × 48 帧 = 7×7 格,
  单张 3584² RGBA ≈ 51MB, 加 mipmap 后四张图集约 **270MB 显存** —— 仓库有过
  `MAX_TEXTURE_IMAGE_UNITS` 顶到 17 导致地形材质编译失败的先例, 这类开销要当回事。
  256px/格 → 四张合计约 **68MB**。`--cell 512` 一行可切回。
- **烘焙成本**(GTX 1080 / CUDA 实测): 两个预设全量约 80~90 分钟, 其中仿真烘焙
  约 14 分钟。改档位前先跑 `blender/vfx/00_probe.py` 拿本机真实速率。
- **旧的 `explosion-fire/smoke.png`(程序化, 8×8×128)保持不动** ——
  它挂在 `WeaponSystem` 的死路径上, 动它只有回归风险。
- **OPTIX 在这台 Pascal 卡上不可用**, 管线默认走 CUDA(见 `vfx_lib.setup_cycles`)。
- 本管线只做**爆炸**两档。炮口焰 / 导弹尾迹 / 命中火星 / 舰船尾迹 / 地面扬尘
  仍是程序化贴图, 接入方式相同, 后续可以按同一套契约扩。

---

## 6. 目录索引

| 路径 | 作用 |
|---|---|
| `blender/vfx/README.md` | **契约 + 踩坑记录(唯一真值)** |
| `blender/vfx/vfx_lib.py` | 共用库: 域/源/材质/相机/取景/淡出 |
| `blender/vfx/00_probe.py` | 环境 + 计时探针(先跑) |
| `blender/vfx/{10,20,30,40}_*.py` | 建场 → 烘缓存 → 渲帧 → 接片 |
| `blender/vfx/bake-all.sh` | 一条命令走完全部预设 |
| `scripts/vfx-atlas-pack.mjs` | **游戏侧唯一入口**: 校验 + 打包 + 写 fx-tune |
| `scripts/blender-mcp.mjs` | 直连 Blender 内的 MCP 桥(交互调参用) |
| `scripts/fx-ab-shot.mjs` | 游戏内 A/B 截图门 |
| `src/lib/fx/fx-core.ts` | 粒子系统 + `SheetUrlResolver` 注入点 |
| `src/lib/game/fx-battle.ts` | 槽位分发层(接 `assetUrl`) |
