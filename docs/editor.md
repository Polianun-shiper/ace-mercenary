# 地形编辑�?UE5 编辑器式独立应用)

> 与游戏本体的关系 = **UE 编辑�?�?UE 游戏**:独立入口、独�?React 根�?> 同一构建管线、同一 public/ 资产;编辑器的世界构建 1:1 复用
> `environment.ts` 的构建函数并走与游戏相同�?`terrain-tune` 覆盖路径,
> 因此编辑器里的观�?= 游戏里的观感(任务覆盖除外)�?
## 1. 入口

| 形�?| 地址 |
|---|---|
| Next dev 路由 | `http://localhost:3000/editor`(`src/app/editor/page.tsx`) |
| dev 静�?| `node scripts/serve-test.mjs` �?`http://127.0.0.1:8898/editor/index.html` |
| 单文件部�?| `dist-editor/index.html`(双击即用,资产全内�? |

构建:`scripts/build-single-html.mjs` 已多入口�?—�?一次产�?`dist-single/index.html`(游戏)+ `dist-editor/index.html`(编辑�?,共享
`__ASSET_MANIFEST`/`__KTX2_MANIFEST`(�?basis 转码器、地�?KTX2�?`/config/terrain-tune.json`)�?
## 2. 功能

- **UE5 式自由飞行视�?*:右键环视、WASD 平移、Q/E 升降、Shift×3 加速�?  滚轮调飞行速度(单位/�?显示�?HUD)�?- **地形**:size/segments/maxHeight/seed/噪声模式/岛屿衰减/4 色�?  分位分带(lowTop/vegiTop/rockTop/bandQ/雪带开�?、高度图 AO(强度/�?  半径/方位�?。重型参数改�?**400ms 防抖重建**(有进度提�?�?- **分层材质(实时,零重�?**:tileSize、低洼暗�?阈值、法线强度、宏 AO�?  4 槽平铺倍率 —�?直接�?shader uniform(`_tuneUniforms` 句柄)�?- **植被/城市**:InstancedMesh 集群�?count/spread/坡度/高度�?seed�?  城市规模/街区,开关即重建;HUD 显示实例数�?- **LOD/流式实验**:环形流式模拟开关、lodScale/lod0Radius、chunk 边界
  线框叠加(�?LOD 着�?绿→黄→橙→�?,与游�?`updateTerrainStreaming`
  同规则的精简版�?- **指数高度�?*:颜色 + FogExp2 密度,**实时**�?- **天空/太阳**:预设 + 天气、太阳方位角/仰角/强度、环境光、曝�?太阳
  实时旋转(天空 shader `uSunDir` + 方向�?+ 日盘)�?- **资产放置**:飞机(f16/b52/ac130/su35/f15/a10)、载具、设施、地形道具�?  灯光、几何体;地面射线放置;选中�?**W/E/R 切换移动/旋转/缩放 gizmo**
  (拖拽时自动冻结飞行相�?;Delete 删除、Esc 取消选择�?- **天光捕获 + 反射捕获�?*(debug):天光�?= PMREM 大气天空生成全局 IBL
  (天空参数变化自动重生�?;反射捕获�?= CubeCamera 六面 �?PMREM,球面
  显示捕获环境,可开�?半径内材质应�?envMap"�?- **保存/导出**:项目 JSON(localStorage `skybound.editor.project` + 下载/
  导入,含全部参�?+ 放置�?;**导出 terrain-tune.json** 融合进游戏�?
## 3. 导出 �?游戏本体融合(工作�?

1. 编辑器里调好 �?点「导�?terrain-tune.json」→ 得到下载文件并同时写�?   localStorage(`skybound.terrainTune`)供本地热�?重启游戏关卡生效)�?2. 融合进仓�?把下载的 JSON 覆盖 `public/config/terrain-tune.json` �?   重新构建(dev 或单文件)�?*AI/程序融合只需维护这一�?JSON**�?3. 优先级链:`mission.terrain` 覆盖(任务雪线/配色)> 用户 localStorage
   设置(LOD/bloom �?> terrain-tune > 代码默认�?   消费�?`src/lib/game/terrain-tune.ts`(加载)+ `environment.ts`
   `buildHeightmapTerrain(opts.tune)`(地形/分带/AO/材质)+ `engine.ts`
   `loadSky`(�?太阳/曝光/bloom/LOD/植被/城市)�?
## 4. 实现结构

| 文件 | 职责 |
|---|---|
| `src/lib/editor/editor-params.ts` | 参数 schema + 默认 + JSON 序列�?+ `exportTuneDoc` |
| `src/lib/editor/editor-world.ts` | 场景/渲染/重建管线、实�?uniform、流式模拟、放�?选择 |
| `src/lib/editor/editor-camera.ts` | 自由飞行相机 + 地面射线 |
| `src/lib/editor/editor-placement.ts` | 资产�?PALETTE)+ 大纲 ActorStore + TransformControls 封装 |
| `src/lib/editor/editor-probes.ts` | 天光(PMREM 全局 IBL)+ 反射捕获�?|
| `src/components/editor/EditorApp.tsx` | 布局 + Inspector/大纲/HUD/顶栏(保存/导入/导出) |
| `src/standalone/editor-entry.tsx` | 单文件入�?|
| `src/lib/game/terrain-tune.ts` | 游戏�?tune 加载/分发(编辑器不依赖游戏运行,仅类型同�? |

## 5. 已知边界(v1)

- 编辑器默认开阴影(2048,跟随视口�?;bloom 用轻�?UnrealBloomPass�?- 反射捕获�?v1 �?debug �?捕获 128²,应用半径内材�?envMap 是简化实�?  (非逐物体包围盒);天光为全局(UE 亦为全局天光)�?- 编辑器地图槽 = 游戏 `mapType`(mountain/desert/archipelago);
  `city`/`ocean` mapType 未列入编辑器(城市参数在游�?city 分支消费)�?- 放置物序列化只存 def+变换;procedural 资产载入时重�?灯光/探针参数
  简化为默认)�?- `terrain-tune.json` �?AI/程序负责合并版本(合并多份导出时逐字段取�?�?
## 6. 分层基准(quantile / absolute)+ 高度切片

- `bandMode='quantile'`(默认):边界取真实高度分布分�?面积均衡 —�?适合
  单峰/均匀地形�?- `bandMode='absolute'`:�?*固定海拔平面**切片(300/1200/2600m �?—�?多座
  不同高度山峰共享同一�?�?�?�?海拔�?�?UE 的绝�?Height 遮罩�?- Inspector「分层基准」节可实时切换并显示三个边界当前高度;勾选「显示高�?  切片平面」在地图上铺三张半透明着色平�?�?�?岩边界色),直接目视
  "分层基准落在哪个平面高度"。两者都�?terrain-tune 导出进游戏�?
## 7. 植被 / 城市素材编辑

- 植被素材�?�?针叶/阔叶/灌木/树干 5 �?+ �?灌木/�?3 个尺寸乘�?+
  草丛/灌木数量 —�?全部�?`buildTerrainForest` �?`colorTune/scaleTune/
  grassCount/bushCount`,引擎 tune 透传�?- 城市素材�?玻璃�?办公�?住宅/地标 4 �?×(底色/窗色/发光强度)—�?  `buildCity` �?`colorTune`(窗纹理与发光材质同步重生�?�?
## 8. 场景阴影(3A)

- 画质�?阴影开�?/ 分辨�?1024/2048/4096)/ 软度�?- 实现:太阳 DirectionalLight 阴影,ortho �?±2600m 跟随编辑器相机并
  **texel 对齐 snap**(消除移动闪烁);地形接收、植�?城市实例与放置物
  投射,海洋/天空/�?切片层不参与�?
## 9. Mask Splatting:自动分层 �?遮罩双模�?游戏设置 �?玩法分布)

**理念**:不直接给地形贴一张大�?而是�?*单张 RGBA 遮罩**(R/G/B/A =
低地/�?�?�?对应 4 层细节纹理与 splat 槽位)控制每层在何处以何权�?混合 —�?UE "Splatting" �?web 版。自动分�?= 顶点权重(现有分位/绝对
分带);遮罩模式 = 逐像素读贴图(编辑器可�?�?
- **编辑器「纹理分�?· Mask Splatting」节**:模式 radio 自由切换(实时
  uniform,零重�?;「自动生成遮�?按当前分�?�? 程序化来�?分位�?  绝对海拔 + 坡度光栅�?512/1024/2048²,默认 1024�?2m/纹素);**手绘
  通道**:选层(低地/�?�?�?+ 半径 + 强度,按住左键在地形上"�?权重
  (UE �?redistribute 逐像素归一);「保存项�?/ 导出」把遮罩 PNG
  dataURL 一并持久化�?- **游戏�?*:导出 tune �?`material.maskMode + maskPng`(dataURL 嵌入
  JSON)—�?引擎 loadSky 解码 �?`terrainWeights()` 逐像素采�?遮罩缺失
  自动回退顶点分层�?*融合依旧只改 terrain-tune.json 一个文�?*�?- shader 细节:mask 贴图线性采�?+ mip + aniso;采样权重归一�?三处
  消费�?albedo / 层法�?octave / 层粗糙度)共用 `terrainWeights()`�?- **留档(未实�?后续可加)**:第五�?额外通道、B 通道存高度做
  "height-based blend"(现代引擎进阶混合)、多张遮罩合并大纹理�?
## 10. 指数级高度雾(所在高�?+ 生效/变化范围)

- Fog 节上�?= 传统距离�?FogExp2 颜色/密度);下半 = **指数级高度雾
  体积**(UE ExponentialHeightFog 风格):
  - 浓度 opacity / **所在高�?baseHeight**(雾集中平�?/ **衰减范围
    falloff**(向上指数淡出的米�?/ 生效距离 startDistance / 最大距�?    fadeEnd(远墙前淡出归�?�?  - 渲染:横贯地图的雾�?片元 alpha = opacity × heightProfile(y) ×
    距离 fade—�?低洼谷雾、山体穿�?深度测试保证地形遮挡正确�?- 编辑器实时调�?导出�?`global.fog.heightFog`,游戏 loadSky 应用
  (默认�?零回�?开启后导出即融�?�?
## 11. 游戏设置:SSAO(默认�?

- Settings �?画质新增 SSAO 开�?+ 半径滑条(`skybound.ssao` /
  `skybound.ssaoRadius`,2-24 默认 6)。engine 半分辨率 16-kernel SSAOPass
  仅在该开关开启且非移动端时创�?改动在下一次进入关卡时生效�?
## 12. 导入地形实测 + 四图层独立对�?2026-09)

- 顶栏 `�?测试 004 导入地形` �?`loadGaea004()`(EditorApp.tsx):�?  `public/config/terrain-tune.json` �?`maps.custom`,加载高度�?  (`loadExternalHeight`,支持 `f32bin` �?**`f32bin-gzip`** 两种 kind)+
  `color.jpg` / `normal.jpg` / `ao.jpg`, `setExternalPack()` 注入后重�?  视口;相机传送到 `(0,7000,6000)` 看向 `(0,1600,0)`,并强制白�?  (`sun 3.2 / ambient 0.95 / exposure 1.6`)—�?专为"看清 001/004 导入
  资产"准备的测试入口�?- **四图层独立对齐控�?*(顶栏):先点图层按钮 **高度 / 基础�?/ 法线 / AO**,
  再用 `�?0°` / `⇋X` / `⇅Y` / `复位`。每次只�?  `maps.custom.transform.<layer>`(`{rot,flipX,flipY}`),然后重跑
  `loadGaea004()` 即刻看效�?—�?高度场走 `applyGridTransform`,贴图�?  `transformImageToCanvas`,两者同�?flipY→flipX→rotCW)保证对齐�?  顶栏右侧实时显示当前图层变换(�?`270°`、`90°/X`)�?- 修正保存位置:编辑器项�?JSON(`world.params.maps.custom.transform`)>
  tune 里的 `transform`(无手工修正时自动沿用 tune)。导�?  terrain-tune.json 即把修正带到游戏�?`engine.resolveExternal` 消费)�?- 相关:场景阴影恢复(导入地形网格 `castShadow/receiveShadow = true`,
  否则"地图没有光影质感"),�?`DEVELOPMENT.md` §58�?- 编辑器界面已并入磁带朋克配色(琥珀/暖灰 + `tp-panel` 烟熏面板),与主
  界面视觉同调;主界面视觉系统见 `DEVELOPMENT.md` §61�?
## 13. UI 视觉验收工具(scripts/ui-shot.mjs)

- `node scripts/ui-shot.mjs <url> <out.png> [--w ][--h ][--wait ][--js "�?]`
  —�?自建 headless 浏览器的 CDP 截图工具(`msedge --headless --screenshot`
  在本�?Edge 141 上会静默失效)�?- `--js` 可切换界面并断言状�?�?
  `--js "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('测试 004')).click()"`
- **会打印页面报�?*(异常 + console error/warning),是排�?界面看着在�?  其实每帧抛异�?这类问题的关键手段�?
