# Blender 地形烘焙 → 游戏 导入工作流

> 目标:在 Blender 里把地图烘成一套贴图,导进游戏后**在实时关卡里看到接近
> Blender 渲染的效果**,并且"贴图/光照贴图不错位、不串通道、不静默失效"。
>
> 这套流程与 `docs/gaea-import.md` 的 Gaea 线是**并列的两条入口**,最终汇到
> 同一个消费端(游戏的地形材质)。两条线共用同一个世界域约定,所以可以混用
> (例如 Gaea 出高度/色图,Blender 出烘焙光照图)。

---

## 0. 一句话流程

```
Blender 脚本烘出通道图 + bake.json
  → node scripts/blender-pack.mjs <bake目录> --slot <地图槽>
  → 自动归一化/打包成 public/custom-maps/<slot>/bake.png
  → 自动写 public/config/terrain-tune.json 的 material.bakeMap
  → 游戏启动即生效(无需改代码、无需重新构建)
```

---

## 1. 为什么要有"打包器"这一层(设计理由)

Blender 直接吐"游戏格式"看着省事,但会把约定散进场景设置里 —— 而这类错误
的表现是**画面"看着怪但说不出哪错"**(整体偏暗?贴图重复?通道反了?),
排查成本极高。所以约定集中在 `scripts/blender-pack.mjs` 一处:

| 关注点 | 由谁负责 | 出错时的表现(若不校验) |
|---|---|---|
| 世界域 UV、行 0 = −Z | 脚本声明 + packer 归一化 | 贴图整体旋转/镜像,湖山错位 |
| 通道顺序 R/G/B | 脚本声明 + packer 校验 | AO 被当太阳可见度用 → 整体诡异变暗 |
| 线性 vs sRGB | packer **硬失败** | AO/GI 数值失真、压暗或发灰 |
| GI 归一化口径 | packer 按 p95 归一 | 间接光整体偏亮/偏暗 |
| 太阳通道去 N·L | packer 用高度场算几何 | 直射光被双重乘 N·L → 掠射角变黑 |
| 朝向自检 | packer 报相关系数 | 翻转/旋转错位却"看起来还行" |

---

## 2. 约定(规则) —— 这是唯一真值

### 2.1 世界空间
游戏:右手系,**Y 轴朝上**,单位米,地形覆盖 `X/Z ∈ [−size/2, +size/2]`。
Blender:右手系,Z 轴朝上。转换:

```
game (X, Y, Z)  →  Blender (X, −Z, Y)
```

该转换保持右手性(不是镜像)—— 法线绕序与切向不会翻。

### 2.2 世界域 UV 与"行 0 = 世界 −Z"
所有世界域贴图(色图 / 遮罩 / 法线 / 烘焙图)共用:

```
u = (worldX + size/2) / size
v = (worldZ + size/2) / size        ← 纹理行 0 对应 worldZ = −size/2
```

代码里两处逐位一致,改一处必须改另一处:
- `src/lib/game/pbr/terrain-v2.ts` 写入的 `uv2`(channel 2,世界域 UV)
- `src/lib/game/pbr/layered-terrain.ts` 的 `(vWorldPos.xz + uMaskHalf) * uMaskInvSize`

Blender 侧图像 `v=0` 是最下面一行,存成 PNG 后文件第一行是 `v=1`,所以烘到
UV 上的映射是:

```
uv.x = (worldX + size/2) / size
uv.y = 1 - (worldZ + size/2) / size
```

配合"俯视正交相机、相机上方向 = Blender +Y"(脚本默认),产出 PNG 即为游戏
约定,**无需旋转/镜像**。若你改了布局,请在 sidecar 的
`convention.transform` 里如实声明 —— packer 会归一化并记录,不会静默错位。

### 2.3 打包烘焙图通道契约(单张 RGBA,`bake.png`)

| 通道 | 含义 | 取值 | 游戏消费方式 |
|---|---|---|---|
| **R** | AO 环境光遮蔽 | 1 = 无遮挡 | three 内置 `aoMap` 管线,强度 = `material.aoMapIntensity` |
| **G** | GI 间接光/天光弹射 | 1 = 全天空 | 乘在间接光上,强度 `uBakeGI`(默认 1) |
| **B** | 太阳可见度 | 1 = 见太阳,0 = 被山体挡 | 乘在直接光上,强度 `uBakeShadow`(**默认 0**) |
| **A** | 保留 | 255 | 未来:湿度/雪线/泡沫掩码 |

三条都是 **0..1 的乘数(线性数据)**,不是颜色:

- Blender 里存 PNG 时 color space 用 **Non-Color**;
- **不要**让 Film / View Transform / exposure 参与(脚本强制 `Standard` + exposure 0 + gamma 1);
- 打包器会对 `channelColorspace != 'Non-Color'` **直接硬失败**(这条踩过: sRGB 编码会让 AO 数值非线性失真)。

### 2.4 为什么 B(太阳可见度)默认不生效

实时阴影已经在跑(机体自阴影 / CSM / 静态阴影)。Blender 烘的太阳可见度是
**远景大尺度投影**(整条山脊投到山谷里),而实时阴影只有 ±4~6km 的覆盖。
两者叠加会双重变暗,所以默认 `bakeShadow: 0`,确认不冲突后再开
(`--sun 0.5` 或改 tune 的 `material.bakeShadow`)。

### 2.5 与"顶点高度图 AO"的关系

游戏另有一套逐顶点 AO(拿高度场邻域近似,`terrain-tune` 的 `macroAO`)。
**有烘焙 AO 时它会被自动置 0**(两者语义重复,叠乘会让山谷/背光面偏黑;
`macroAO` 显式给值时仍以用户为准)。packer 会把 `macroAO: 0` 写进 tune,
让意图留痕。

---

## 3. Blender 侧:怎么烘

脚本:`tools/blender/skyace_terrain_bake.py`(模块头就是这套约定文档)。

```bash
blender -b -P tools/blender/skyace_terrain_bake.py -- \
    --height  public/custom-maps/custom/heights.f32bin \
    --size 48600 --max-height 4320 \
    --res 2048 --samples 256 \
    --sun-elevation 38 --sun-azimuth 145 \
    --out bake/blender
```

脚本做的事:

1. 读游戏的 `heights.f32bin`(float32 LE、米、行主序、`cy=0` 在 −size/2 一侧),
   按 2.1 的转换建成网格;
2. 建天光(Nishita 天空纹理)+ 独立太阳灯(仰角/方位角与游戏 sky preset 对齐);
3. 俯视正交相机(上方向 +Y)→ 烘出的图天然满足 2.2;
4. 烘 4 个 pass:
   - **AO**:关掉太阳只留天光,`bake_type='AO'`;
   - **GI**:`DIFFUSE` + 只留 indirect,材质基础色临时强制纯白(结果 = 纯白漫反射面收到的光,不含材质色)→ 输出 `bake_gi_raw.png`(未归一);
   - **太阳**:关天光、只留太阳、能量归 1,`DIFFUSE` + 只留 direct → `bake_sun_raw.png`(未归一,=`N·L × 可见度`);
   - **法线**:`NORMAL`(切线空间,世界域);
5. 写 `bake.json` sidecar(**packer 的唯一依据**)。

> ⚠️ 参数必须与游戏一致:太阳仰角/方位角要与该关卡天空预设相同,否则烘出来的
> 阴影方向与实时太阳打架。sidecar 会记录这两个值,packer 用它们做去调制与自检。

> 🔁 **Blender 未安装也能先跑通管线**:跳过 Blender,直接用 `--ao/--gi-file/--sun-file`
> 走手动路径(下一节),先把打包/校验/接入这条链走通。

---

## 4. 打包(游戏侧唯一入口)

```bash
# A. 从 Blender 输出目录(读 bake.json)
node scripts/blender-pack.mjs bake/blender --slot custom

# B. 只给现成的通道图(Gaea AOExport 等;缺的通道自动填中性值)
node scripts/blender-pack.mjs --slot custom \
     --ao public/custom-maps/custom/ao.jpg \
     [--gi-file gi.png --gi-raw] [--sun-file sun.png --sun-raw] \
     [--normal normal.png] [--color color.png]

# 只校验不落盘(CI / 先看统计)
node scripts/blender-pack.mjs bake/blender --slot custom --dry-run
```

常用选项:

| 选项 | 作用 |
|---|---|
| `--res 2048` | 目标分辨率(2 的幂;缺省取 sidecar/高度包) |
| `--height <f32bin\|gz>` | 高度场:算太阳通道的几何 N·L + 朝向自检;缺省从 tune 取 |
| `--sun-elev/--sun-azim` | 太阳方向(度);缺省取 sidecar |
| `--ao-intensity 1` | R 通道强度 → `material.aoMapIntensity` |
| `--gi 1` / `--sun 0` | G / B 通道强度 → `material.bakeGI` / `bakeShadow` |
| `--flip-x/--flip-y/--rot 90` | 按 2.2 的**约定顺序**(flipY→flipX→rotCW90)归一化 |
| `--dry-run` / `--no-tune` | 只校验 / 不改 tune |

打包器会:

1. 校验 sidecar 约定(`upAxis/row0/col0/channelColorspace`)——缺失或错标**硬失败且不写任何文件**;
2. 逐通道:读 → 按约定变换 → 重采样 → 归一化(GI 按 p95;太阳按几何 N·L 去调制,背光面置 1);
3. 统计与告警(AO 均值偏低 / GI 动态范围为零 / 太阳通道全 1 等);
4. **朝向自检**:算 `corr(太阳 raw, 几何 N·L)`,低于 0.35 就告警 —— 这是抓"翻转/旋转错位"最有效的一条;
5. 写 `bake.png` + 更新 `terrain-tune.json`(`material.bakeMap/bakeMode/bakeAO/bakeGI/bakeShadow/macroAO=0/normalWorldDomain=true`)+ 更新 `manifest.json`。

---

## 5. 游戏侧怎么消费(已就绪,无需再改)

`src/lib/game/engine.ts`:

- `resolveBakeMap(mTune)`:`material.bakeMap` 优先,退回旧的 `material.aoMap`;
- 传进 `buildHeightmapTerrain({ bakeMap, bakeIsAoOnly })` → `layered-terrain.ts`。

`src/lib/game/pbr/layered-terrain.ts`:

- **R** → 直接作为 `material.aoMap`(贴图 `channel = 2` 走世界域 `uv2`),
  强度 `aoMapIntensity`;顺带免费获得间接高光的 AO;
- **G/B** → 在 `#include <aomap_fragment>` 之后注入,采样**同一个** `aoMap`
  纹理(`vAoMapUv`)→ **净增 0 个纹理采样器**;
- 有烘焙 AO 时 `uMacroAO` 自动置 0(避免与逐顶点 AO 双重变暗)。

**为什么执着于"不新增采样器"**:这个材质长期贴着
`MAX_TEXTURE_IMAGE_UNITS`(很多 GPU/ANGLE 只有 16),项目档案里有过
"顶到 17 → 地形材质编译失败 → 地表完全不画,只剩 skirt"的事故。当前材质
采样器总数 14,`scripts/test-terrain-shader-inject.mjs` 会守住这条线。

---

## 6. 验证(每次导入后跑一遍)

```bash
node scripts/blender-pack.mjs <bake> --slot custom --dry-run   # 约定/统计/朝向自检
node scripts/test-blender-pack.mjs                            # 打包器端到端(合成图)
node scripts/verify-shader-anchors.mjs                        # 注入锚点守门(three 升级后必跑)
node scripts/test-terrain-shader-inject.mjs                   # 注入是否真的生效 + 采样器预算
node scripts/verify-level-render.mjs --url http://127.0.0.1:3111/ \
     --mission M13 --weather 晴 --out .shots/verify/custom      # 真·WebGL 编译 + 定点截图
```

`verify-level-render.mjs` 会:进关卡 → **固定天气**(天气是随机的,A/B 必须固定)→
暂停世界 → 把相机摆到定点姿态(俯视/斜视/陡俯/低空)→ 逐张截图 →
收集 `window.__glErrors/__jsErrors` 与地形着色器自检日志。任何
`console.error` / 未捕获异常 / GL 错误都会让它以非 0 退出。

游戏内另有一条自检日志(每次地形材质编译打一次),看到它全 `ok` 才算注入都在:

```
[terrain] 注入自检(mountain): splat/ao=ok 层法线=ok 层粗糙度=ok 顶点AO=ok 烘焙=… 外部法线=世界域(uv2)
```

---

## 7. 已修的真实缺陷(为什么以前"看着怪")

| # | 缺陷 | 现象 | 根因 | 修法 |
|---|---|---|---|---|
| 1 | 外部法线按 chunk UV 采样 | 每个 chunk 都显示一整张法线图(19×19 块 = 整图重复 361 次),法线尺度全错、与色图/AO 不对齐 | `normalMap` 走 chunk 自带 0..1 UV 且 `repeat=(1,1)`,但外部法线是**整图世界域**烘焙 | terrain-v2 把世界域 UV 写进 `uv2`;材质把该贴图指到 `channel = 2`(创建期设,`getParameters` 早于 `onBeforeCompile` 读它) |
| 2 | Gaea `AOExport` 根本没进渲染 | 传了 `externalAo` 却无人消费 —— 地表没有烘焙遮蔽,山谷发平 | `uExtAo` 采样器为省纹理单元被删后,该参数成了死参数 | AO 改走内置 `aoMap` 槽位(channel 2),并新增 G/B 通道复用同一贴图 |
| 3 | 三类注入静默失效 | 层法线 octave / 逐层粗糙度 / 顶点高度图 AO **从未生效** | 锚点写在 ShaderChunk **正文**里,而 `onBeforeCompile` 在 `resolveIncludes` **之前**执行 → 永远匹配不到;且三处共用同一个 `_mwamWarned` 标志,只打印一条 warn 互相掩盖 | 锚点改到 `#include <...>` 行并在其后追加;`scripts/verify-shader-anchors.mjs` 永久守门 |
| 4 | relief 平铺注释与实现不符 | 注释写"120m 一贴",实际 ≈6.3m(120/chunkCount) | `repeat = size/120` 作用在 chunk 自带的 0..1 UV 上 | 参数化为 `material.reliefTileSize`(米/重复);缺省保持历史值,写 120 即原始意图 |

---

## 8. 常见坑

- **贴图整体旋转/镜像** → 看 packer 的"朝向自检 corr"是否偏低;确认 Blender 布局与 sidecar 声明一致。
- **地表整体偏亮/偏暗** → 先看 GI 的 p50/p95(动态范围为零说明 indirect 没接上);
  再调 `material.bakeGI` 与 `material.aoMapIntensity`(都可运行时改:
  `__engine._terrainMaterial.userData._tuneUniforms.bake`)。
- **直射光诡异变暗** → `bakeShadow` 开关与实时阴影叠加了,把它设回 0。
- **AO 通道像"脏"或发灰** → 检查是不是做了 sRGB 编码(packer 会硬失败,不该发生)。
- **three 升级后地形变平** → 跑 `verify-shader-anchors.mjs`,锚点漂移会立刻报出来。
- **采样器预算** → 任何时候都不要给地形材质净增采样器;要加数据就复用现有槽位或打包进已有贴图的通道。

---

## 9. 路线图(还没做的)

- **UV2 通道的物件级光照贴图**:目前烘焙图是"世界域投影到地形",对静态物件
  (机库/建筑)不适用。要做物件级 lightmap 需要:几何带 uv1 + `lightMap` 槽位
  (`Texture.channel = 1`)+ 打包器把 Blender 的物件烘焙按物件 UV 导出。
  当前仓库**没有任何 uv1/lightmap 管线**,是从零开始的工作。
- **反射捕获球**:`src/lib/editor/editor-probes.ts` 已有 CubeCamera + PMREM 的
  编辑器实现(未序列化)。把它接进关卡 = 地形/水面获得局部反射。
- **KTX2 烘焙图**:`bake.png` 是 2048² RGBA(约 1~3MB)。单文件构建有 64MB
  上限,若要更高分辨率或更多通道,应走 `scripts/ktx2-export.mjs` 的 basisu 路径。
