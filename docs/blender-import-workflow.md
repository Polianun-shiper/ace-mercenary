# Blender 导入工作流（统一契约）

> 这份文档是 **E:\ipbeifen2-dsh** 的 Blender→游戏 导入规范。
> 它合并了两条线，并明确它们**必须共用的约定**：
>
> | 线 | 对象 | 烘焙方式 | 消费方式 |
> |---|---|---|---|
> | **地形线** | 关卡地形（整块世界域） | 俯视正交，世界域 UV | `aoMap` 槽 + `channel 2`，R/G/B 通道打包 |
> | **物件线** | 机库等静态建筑 | 物件自身 UV（lightmap 图集） | `lightMap` 槽 + `channel 1` |
>
> 地形线移植自隔壁工作树（`blender-pack.mjs` / `skyace_terrain_bake.py` /
> `docs/blender-pipeline.md`，那份文档保留为地形线的详细规格）。
> 物件线是本工作树实现的，**正好补上那份文档 §9 列为"从零开始"的
> uv1/lightmap 待办**。
>
> 两条线共用同一个**世界坐标约定**与**数据贴图色彩空间约定**，所以可以混用
> （例如地形用 Gaea 出高度/色图、Blender 出烘焙光照）。

---

## 0. 先说三条铁律（踩过的坑都在这里）

1. **数据贴图必须是 `NoColorSpace`。**
   法线 / 粗糙度 / AO / GI / 光照贴图都是**线性数据**，不是颜色。一旦被
   sRGB 编码，数值会非线性失真——表现是"整体偏暗/发灰但说不出哪错"。
   地形线的打包器对 `channelColorspace != 'Non-Color'` **硬失败**。

2. **`Texture.channel` 决定 three 去哪套 UV 采样。默认是 0。**
   `getChannel(0) → 'uv'`，`getChannel(1) → 'uv1'`，`getChannel(2) → 'uv2'`。
   - 物件光照贴图在 uv1 → 必须 `lightMap.channel = 1`
   - 地形烘焙图在世界域 uv2 → 必须 `bakeMap.channel = 2`
   **漏设不会报错**，只会拿另一套 UV 去采样，画面"看着怪但说不出哪错"。
   机库第一版就栽在这里：拿世界坐标的平铺 UV 去采样一张烘焙图集。

3. **Blender 侧太阳方向必须与游戏该关卡的天空预设一致。**
   游戏侧 `SkyConfig.sunPos` 是单一真值；HDRI 关卡更特殊——
   `sampleHdrSkyInfo()` 会**从 EXR 里量出真实太阳方向并覆盖 `cfg.sunPos`**。
   烘错了表现是"实时阴影与烘焙明暗打架"。

---

## 1. 世界空间（两条线共用）

```
game (X, Y, Z)  →  Blender (X, −Z, Y)
```
右手系保持（不是镜像），法线绕序与切向不会翻。

地形世界域 UV：

```
u = (worldX + size/2) / size
v = (worldZ + size/2) / size        ← 纹理行 0 对应 worldZ = −size/2
```
Blender 侧图像 v=0 在最下、存 PNG 后第一行是 v=1，所以烘到 UV 上是
`uv.y = 1 - (worldZ + size/2)/size`。配合"俯视正交 + 相机上方向 = Blender +Y"
即天然满足，无需旋转镜像。

---

## 2. 地形线：世界域通道打包（R=AO / G=GI / B=太阳）

单张 RGBA `bake.png`，三条都是 **0..1 线性乘数**：

| 通道 | 含义 | 取值 | 游戏消费 |
|---|---|---|---|
| **R** | AO | 1 = 无遮挡 | three 内置 `aoMap` 管线，强度 `aoMapIntensity` |
| **G** | GI 间接光 | 1 = 全天空 | 乘间接光，`uBakeGI`（默认 1） |
| **B** | 太阳可见度 | 1 = 见太阳 | 乘直接光，`uBakeShadow`（**默认 0**） |
| **A** | 保留 | 255 | 未来：湿度/雪线/泡沫 |

**B 默认不开**：实时阴影（CSM/静态/跟拍）覆盖 ±4~6km，而烘焙的太阳可见度是
远景大尺度投影，叠加会双重变暗。确认不冲突后再开。

步骤：

```bash
# 1. Blender 烘（仰角/方位角必须与关卡天空预设对齐）
blender -b -P tools/blender/skyace_terrain_bake.py -- \
    --height public/custom-maps/<slot>/heights.f32bin \
    --size 48600 --max-height 4320 --res 2048 --samples 256 \
    --sun-elevation 38 --sun-azimuth 145 --out bake/blender

# 2. 打包（校验约定 + 归一化 + 写 tune）
node scripts/blender-pack.mjs bake/blender --slot <slot>

# 3. 只校验不落盘
node scripts/blender-pack.mjs bake/blender --slot <slot> --dry-run
```

打包器做四件容易静默出错的事：GI 按 p95 归一、太阳通道用高度场算的几何 N·L
**去调制**、朝向自检 `corr(太阳raw, 几何N·L)` 低于 0.35 告警、有烘焙 AO 时把
`macroAO` 自动置 0。

### ⚠ 本工作树的地形消费端还没接

移植过来的只有**打包器与 Blender 脚本**。游戏侧还缺：

- `engine.ts` 的 `resolveBakeMap(mTune)`（`material.bakeMap` 优先，退回 `aoMap`）
- 把 `bakeMap` 传进 `buildHeightmapTerrain(...)`
- `layered-terrain.ts` 里 G/B 两个通道的注入

注入点在 `layered-terrain.ts` 的 `#include <aomap_fragment>` 之后，复用
**同一个** `aoMap` 采样器与 `vAoMapUv`，因此**净增 0 个纹理采样器**——
这条是硬约束：地形材质长期贴着 `MAX_TEXTURE_IMAGE_UNITS`（很多 GPU 只有 16），
项目档案里有过"顶到 17 → 地形材质编译失败 → 地表完全不画"的事故。

---

## 3. 物件线：uv1 光照贴图（本工作树实现）

静态建筑（机库）不能走地形那条世界域投影——它有自己的一套 UV。所以：

| 项 | 约定 |
|---|---|
| 几何 | 每个网格带 **两套 UV**：UV0 = 平铺 PBR 贴图，UV1 = 烘焙图集（不重叠，跑 `uv.lightmap_pack`） |
| 导出 | glTF 的 `TEXCOORD_1`（Blender 导出器会带上全部 UV 层，无需特殊接线，已实测） |
| 贴图 | 光照图集单独作为**同级文件**发布，**不塞进 GLB**——glTF 没有 lightmap 槽位，最近的 `occlusionTexture`/`emissiveTexture` 都不是 three 的 `material.lightMap` 想要的东西 |
| 代码 | `material.lightMap = tex; tex.channel = 1; tex.flipY = false;` |
| 色彩空间 | 光照图集按 sRGB 存（Blender 侧 `image.colorspace_settings='sRGB'`、像素操作在**线性**空间做） |

三个必须同时对的点（每一个错了光照都会整片错乱）：

```ts
lightMap.flipY = false;                    // glTF 的 UV 约定就是 flipY=false；
                                           // 而 loadImageTexture 建的是默认 true 的 CanvasTexture
lightMap.channel = 1;                      // 不设 → 取 UV0 → 拿平铺 UV 采样图集
lightMap.wrapS = lightMap.wrapT = ClampToEdgeWrapping;   // 图集是打包的，不能 repeat
```

### 烘焙步骤（机库实例）

```bash
cd /e/ipbeifen2-dsh

# 1. 建几何 + 材质
blender --background --factory-startup --python blender/hangar/10_build.py

# 2. 烘光照（单遍 DIFFUSE direct+indirect，关颜色通道 = 只烘光照不含反照率）
blender --background --factory-startup --python blender/hangar/70_bake.py

# 3. 导出（512² 贴图、不开 Draco、带 TEXCOORD_1）
blender --background --factory-startup --python blender/hangar/80_export_baked.py

# 4. 入库（校验 GLB + 压缩 + 登记 asset-library.json）
node scripts/blender-import.mjs --src blender/hangar/out/export/hangar_baked.glb --name hangar

# 5. 开发期实时同步
node scripts/blender-watch.mjs
```

关键实现细节（都踩过）：

- **`lightmap_pack` 的参数在 Blender 5.2 变了**：`PREF_ALIGN`/`PREF_UV_ASPECT` 已移除，
  现在是 `PREF_CONTEXT` / `PREF_PACK_IN_ONE` / `PREF_NEW_UVLAYER` / `PREF_BOX_DIV` /
  `PREF_MARGIN_DIV`。
- **`PREF_NEW_UVLAYER=True` 会毁掉 UV0**：它把打包结果写进 UV0、把原世界坐标 UV
  推到新层。正确做法是**先显式建 `Lightmap` 层、设为活动层，再以 `False` 打包**
  （实测 UV0 范围保持不变）。
- **烘进 8 位图会截断**：物理天空的照度是真实量级（相对值上百），必须烘到
  **浮点缓冲**，再按 p99 归一化后写 LDR。第一版烘出来一大片纯白就是这个原因。
- **共享图集要求单网格**：`lightmap_pack` 按对象打包，做不出跨对象图集。静态布景
  因此合并成一个网格（顺带把 draw call 压到最低），材质槽保留。
- **自发光强度要分两份**：Blender 里为了把室内照亮到能烘，灯具强度设 260；
  光照烘进图集后，出货时要压回 2.5（否则灯是死白球）。`80_export_baked.py`
  在导出时临时改，不动 `.blend`。

---

## 4. 海面材质（分析结论 + 升级路径）

现状：`buildOcean(cfg, size)` 是**纯 `ShaderMaterial`**（GLSL1 老符号，
`gl_FragColor`/`varying`/`texture2D`），不走 three 的 ShaderChunk 管线。

**已经做得对的部分**（不必重做）：

- 掠射角泛白的三个来源已收：反射上限 `clamp(schlick*1.05, 0, 0.70)`（原 1.35/0.95）、
  雾混合上限 0.80（原 0.9）、`skyHorizon` 改用天光捕获色而非雾色。
- 颜色/方向全部由 uniform 驱动（`oceanColor`/`deepColor`/`highlight`/`fogColor`/
  `sunDir`/`uSunColor`/`envMap`/`envBlend`/`envIntensity`/`skyZenith`/`skyHorizon`/
  `windDir`/`windStrength`/太阳锥那一组），所以**加关卡预设只需改 `SkyConfig`**。
- 有一个 `uDebugMode` 通道（1=nh 2=glintWide 3=pathK 4=schlick 5=太阳仰角 6=n 7=hv
  8=viewDir），调试时很有用。

**升级要动的地方**（按难度排序）：

| 想加的东西 | 现状 | 要做什么 |
|---|---|---|
| 作者法线图 / 泡沫图 / 粗糙度图 | **零纹理管线**——只采样一张 `envMap`(EXR)，波形与法线全是 shader 里 `vnoise`/`fbm` 算的 | 加 `uniform sampler2D` + 加载路径 + `asset-library.json` 前缀；UV 可以直接用现成的 `vWorldPos.xz`（**这正好适合 Blender 烘的平铺图集**） |
| 反射按粗糙度模糊 | 单次 `texture2D` 隐式 LOD 0，无 LOD 阶梯 | 需要显式 `textureLod` 或在 Blender 侧预烘粗糙度对应的 mip 链 |
| 岸边/深度泡沫 | **完全没有**——没有深度图绑定，没有 Beer-Lambert 吸收 | 需要绑 scene depth（目前只有高度雾 pass 挂过 `attachComposerDepth`） |
| 与水面对齐的 SSR 法线 | 水面 shader 不写 G-buffer | SSRPass 用 `overrideMaterial` 自己出一遍法线，接线时要对齐 |
| 湖面 | ⚠ **`buildAlpineLake` 是第二套独立硬编码 shader**（法线权重 1.4/0.7、镜面 `pow(...,200)*1.4`、雾上限 0.9） | 任何只改 `buildOcean` 的升级都会让湖面停在旧观感；先抽公共材质工厂，或让湖复用海面材质 |

**给 Blender 导入的结论**：海面**最适合**接收作者贴图——因为它已经用
`vWorldPos.xz` 当 UV，而 Blender 烘的正是世界域平铺图。所以海面升级的推荐路径是
**复用第 2 节地形线的那套世界域约定**，而不是发明第三套。

---

## 5. 本工作树发现并已修 / 待修的问题

### 5.1 已修：地形三处注入锚点错误（其中两处已启用）

`layered-terrain.ts` 的三处 `onBeforeCompile` 注入原先都锚在 **ShaderChunk 正文**
上，而 `onBeforeCompile` 早于 three 的 `resolveIncludes` 执行 —— 此刻 shader 里
还是 `#include <xxx>`，正文尚未替换进来，所以 `includes('正文')` 恒为 false，
**三处一起静默失效**。已改成锚 `#include <...>` 行。

但修好之后发现**三者代价不同**，只有一个能安全启用：

| 注入 | 依赖 | 采样器代价 | 状态 |
|---|---|---|---|
| 顶点高度图 AO | `uMacroAO`(float) + `vAo`(varying) | **0** | ✅ 已启用 |
| 逐层粗糙度 | `uLayerRough0..3`(float) | **0** | ✅ 已启用 |
| 层法线 octave | `uLayerNrm0..3`(**4 个采样器**) | **+4** | ⛔ 刻意关闭 |

层法线为什么必须关：修复锚点后那 4 个采样器从"声明但未被使用（被 GLSL 编译器
剪掉）"变成实际使用，片元采样器 **14 → 18 > `MAX_TEXTURE_IMAGE_UNITS`(16)**：

```
FRAGMENT shader texture image units count exceeds MAX_TEXTURE_IMAGE_UNITS(16)
Material Type: MeshStandardMaterial → VALIDATE_STATUS false
```

实测这一步会让 **12 个材质编译失败**。这正是隔壁文档 §8 警告过的事故
（"顶到 17 → 地表完全不画，只剩 skirt"）。要开层法线必须先解决预算，两条路：

- **a)** 把 4 张层法线打包进**一张图集**（1 个采样器，净省 3）——需改
  `terrain-mwam.ts` 的载入端；
- **b)** 把层法线折进一个**已绑定贴图的通道**（例如 albedo 图的 alpha）。

在那之前保持关闭：层法线未启用时语义等价于中性 `(0,0,1)`，与原观感逐位一致。

已加**注入自检**（每次材质编译打一行，并挂 `window.__terrainInject` 供无头验收读）：

```
[terrain] 注入自检: 层法线=skipped(sampler budget) 层粗糙度=ok 顶点AO=ok
```

实测 `#autotest` 进关后：`glErrors: 0, jsErrors: 0`。

### 5.2 待修：物件级 lightmap 的清单登记要带 `.gz` 或目录前缀

`import-asset.mjs` 对 `.glb` 产出 `<name>.glb.gz`；按**文件名**登记前缀会与磁盘
路径对不上，构建期拷贝**静默跳过**（实测 GLB 没进产物）。用目录前缀
（`/models/hangar/`）或带 `.gz` 全名。

---

## 6. 采样器预算红线（给地形加任何数据的先读这条）

地形材质长期贴着 `MAX_TEXTURE_IMAGE_UNITS`。**任何时候都不要给它净增采样器。**
要加数据只能：

- 复用**已绑定的**采样器（像地形烘焙图那样，R/G/B 三通道共用 `aoMap` 一个槽）；
- 或者把新数据**折进已有贴图的空闲通道**；
- 或者把多张同类贴图**打成图集**（4 → 1）。

加之前先数一遍；`scripts/test-terrain-shader-inject.mjs`（隔壁工作树）有这条断言，
本工作树目前靠上面那行注入自检 + 观察 `__glErrors` 守住。

---

## 6. 验证清单（每次导入后跑）

```bash
node scripts/blender-pack.mjs <bake> --slot <slot> --dry-run   # 地形：约定/统计/朝向自检
node scripts/blender-import.mjs --budget                        # 物件：GLB 校验 + 体积
npx tsc --noEmit                                                # src/ + scripts/ 必须 0 报错
node scripts/build-single-html.mjs --dev                        # 开发产物
node scripts/hangar-shot.mjs .shots/x.png --yaw 0.3 --dist 40   # 真 GPU 无头截图验收
```

**截图验收的坑**：`ui-shot.mjs` 是**先 `--wait` 再 `--js`**，所以"点进机库"之后只剩
500ms——机库永远停在"正在加载模型"。必须把"点击 + 等待"整段塞进 `--js` 里
（`Runtime.evaluate` 带 `awaitPromise`），并把 `UI_SHOT_CDP_TIMEOUT_MS` 放宽。
`scripts/hangar-shot.mjs` 就是干这个的封装。

**无头环境能跑真 GPU**：`ui-shot.mjs` 已经用 `--use-gl=angle --use-angle=d3d11`，
实测渲染器是 `ANGLE (NVIDIA GeForce GTX 1080 Direct3D11)`。机库截图黑屏从来不是
WebGL 的问题。
