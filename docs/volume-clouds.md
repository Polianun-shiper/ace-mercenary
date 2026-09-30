# 体积云(实验)·深度整合 + 动态模糊 + HUD 阴影

> 移植自 edgexz「体积云增强版」研究批次:在游戏本体 EffectComposer 链内实现
> **地形深度遮挡的光线步进体积云**(山挡云、云不穿地),并把 动态模糊 /
> HUD 阴影增强 一并内化进现有游戏设置。全部特性**默认关闭/可回退**。

## 1. 设置项(游戏 设置 菜单;engine 在下一次任务开始时读取)

| 键 | 默认 | 含义 |
|---|---|---|
| `skybound.volumeClouds` | off | 体积云总开关(实验)。`on` 时原生贴片/几何云自动整组隐藏(`cloudField.visible=false`),画面由光线步进云接管 |
| `skybound.cloudQuality` | med | 云画质:low 40步/3光步/0.35分辨率 · med 64/4/0.5 · high 96/6/0.7(切档 = defines 重编译 + RT 尺寸重算) |
| `skybound.motionBlur` | off | 动态模糊:按相机角速度对游戏 canvas 施加 CSS blur + scale,HUD 不糊 |
| `skybound.motionBlurStrength` | med | 模糊强度 low 1.6px / med 2.6px / high 3.6px(死区 0.12 rad/s,EMA 平滑) |
| `skybound.hudShadow` | on | HUD 阴影/毛玻璃增强(html 加 `.hud-shadow-off` 即回退基础样式,即时生效) |

限制(设置文案已注明):体积云仅 **forward 管线**生效(deferred 管线下不创建 pass);
**移动画质模式(mobileMode)自动关闭**;改动在下次进入任务时生效。

## 2. 实现结构

| 文件 | 职责 |
|---|---|
| `src/lib/game/volume-clouds.ts` | `VolumeCloudPass`(自定义 Pass,一次 render 完成:①场景渲入低清深度 RT → ②低清云 RT 光线步进(深度截断)→ ③全屏按透射率合成回链缓冲);质量档表 `VOLUME_CLOUD_QUALITY` |
| `src/lib/clouds/shaders.ts` | 云 GLSL 升级:读深度 `readTerrainDistance`(深度比 slab 近则整条裁掉、`tFar=min(slab,地形)`)、光照升级 `lightMarchDual`(Beer-powder 直射 ≥0.18 + 各向同性多次散射 ISO 0.9/0.3 + ISO_PHASE×12)、`#ifdef CLOUD_RAW_OUTPUT` 纯云输出分支(旧单 pass 覆盖模式保持兼容) |
| `src/lib/clouds/volumetric-cloud-pass.ts` | engine-lab(机库 demo)包装器:补 uInvViewProj/uTerrainDepth/uDepthOn uniform;不传深度时保持旧无遮挡行为 |
| `src/lib/game/motion-blur.ts` | `MotionBlurFx`:quaternion 全轴角速度 → EMA → 死区 → 快攻慢收 → 0.25px 量化 → `filter:blur()+transform:scale()` |
| `src/app/globals.css` | HUD 阴影增强(`html:not(.hud-shadow-off)` 下 panel-glass/glow-text/btn-3d 追加阴影与毛玻璃) |
| `src/components/game/Settings.tsx` | 新增 4 个面板:体积云(实验)+云画质、动态模糊+强度、HUD 阴影增强 |
| `src/lib/game/engine.ts` | 接线:ctor 读键、setupPostProcessing 链序(RenderPass→…→SSR→**CloudPass**→Bloom→Output)、每帧 `updateVolumeClouds()`(太阳/天光/天气→覆盖/密度/风速;时间只在非暂停推进)、藏原生云、teardown/dispose |

## 3. 云渲染参数来源(每帧)

- 太阳方向: `sunLight.position` 归一化;太阳色: `cfg.sunColor`;环境色:
  `hemiLight.color × (0.55 + ambientI×0.9)`;强度 `clamp(sunI×0.55, 0.1, 2.2)`。
- 天气 → (覆盖率/密度/风速) 表在 engine `weatherCloudTune()`:clear .34/.9/.13 …
  storm .85/1.3/.42(可调)。
- 云带高度按地图(loadSky 内):mountain 2000–3400 m · desert 1700–3000 ·
  archipelago 1600–2800(可调;山峰穿云即靠它+深度遮挡表现)。
- 深度 RT 语义:与 nimbus 一致 —— 天空/透明物 `depthWrite:false`(environment.ts
  已确认全部为 false),深度 1.0 像素 = 无穷;地形/机体/建筑写入真实深度。

## 4. 已知边界(实验性)

- 云 pass 每帧多渲一次低清场景(深度),像素比例 0.35–0.7;帧率敏感建议 low/med。
- 机舱/座舱盖在云内时会先被深度遮挡(云不会叠在机舱玻璃前)——合理。
- 无时间性重投影/空区跳过(与 nimbus 同档"穷人的体积云"),stutter 较少但采样
  成本与 分辨率×步数 成正比。
- CSS 动态模糊对 canvas 施加 `filter/transform`,与任何外部对 canvas 的 transform
  会互相覆盖(当前引擎没有)。
- 移除了 engine-lab 旧版与云端 lightning 语义差异:lab 仍是单 lightMarch 升级为
  dual-ISO(视觉更柔和),不传深度 = 无遮挡旧行为。
