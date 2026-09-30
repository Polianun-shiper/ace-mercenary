# MWAM 地形自动材质 → web 移植笔记

> 来源:`G:\test1\vngi1\Content\MWLandscapeAutoMaterial`(UE5.8 资产包
> "MW Landscape Auto Material",97 uasset + 3 umap,Textures/ 共 572MB)。
> 移植方针:**换源不换架构** —— splat 分层/世界对齐平铺/高度坡度分带
> 这些与 MWAM 同源的思想照搬(项目里早已实现),只把 4 个图层槽位的
> 程序化画布换成 UE 的 7 层真实材质贴图,并走既有 KTX2/ETC1S 压缩管线。

## 1. UE 资产包架构(学习结论)→ 本项目对应点

| MWAM 材质图单元 | UE 端作用 | 本项目对应 |
|---|---|---|
| MF_MWAM_LandscapeUVs | 世界坐标对齐平铺(不依赖顶点 UV) | `layered-terrain.ts` fragment `vWorldPos.xz * uLayerRepeat` |
| MF_MWAM_DefaultLayer / LayerBlend | 图层堆叠 + splat 权重混合 | `terrain-v2.ts` splat vec4 attribute + CPU `splatAt`(environment.ts) |
| MF_MWAM_SlopeMask / SnowMask | 按世界法线/高度出坡度、雪线软遮罩 | `splatAt` 的 smoothstep 分带 + 坡度转岩规则 |
| MF_MWAM_CombineNormal | 多层法线叠加(多 octave) | `layered-terrain.ts` shader 内 Normal-octave(Whiteout 近似) |
| TEX_MWAM_Variation | 大尺度宏变化遮罩/法线,压制平铺重复 | 预留(variation KTX2 已入库,未接线;见 §6) |
| BP_BakeLandscapeLayers + TRT bake | 把多层烘焙成 1-2 张打包贴图省运行时采样 | KTX2 离线预压缩(等价"bake",只是不做层混合烘焙) |
| 示例 .umap + Landscape 高度 | UE 专用地形数据 | 不搬(我们 48km 程序化高度场 + LOD 流式) |
| 体积云 / 植物网格 / PhyMat | 与 web 端渲染体系无关 | 只学不搬 |

## 2. 移植的资产(public/textures/ktx2/terrain/,1024² ETC1S ≈ 80-190KB/张)

7 层 × albedo+normal: dirt / grass / rock / sand_a / sand_c / snow / stones;
另: variation(normal)、cover_rocks(normal,256² 占位,待兜底导出重编码)、
plants_grass、cover_rocks albedo、variation mask、grass albedo **缺失** ——
.uasset 里无内嵌 PNG,见 §5。

## 3. 地图风格 → 图层槽位(pbr/terrain-mwam.ts `MWAM_PRESETS`)

splat 四通道语义 = 低地 / 植被带 / 岩带 / 雪线带(engine.ts 三处
`terrainStyle: this.mapType` 传入):

| mapType | 低地 | 植被带 | 岩带 | 雪线带 | 备注 |
|---|---|---|---|---|---|
| mountain | dirt | grass | rock | snow | 主视觉 |
| archipelago | sand_a | grass | rock | snow | |
| desert | sand_a | sand_c | rock | dirt | 修掉旧版荒漠长草(旧实现 plains+沙色调) |
| plains(备) | sand_c | grass | rock | snow | canyon(备)同为兜底 |

每槽独立 `scale`(平铺倍数),写入 uniform `uLayerScale0..3`(不再硬编码
1.0/1.3/1.7);控制台 `tilesize` 仍整体缩放。

## 4. 运行时流程

1. `buildLayeredTerrainMaterial`(pbr/layered-terrain.ts):画布 256² 四层照常
   创建(兜底),`onBeforeCompile` 注入 albedo 混合(每槽独立 scale)+
   层法线 octave(在 three r185 `normal = normalize( tbn * mapN );` 行后,
   Whiteout 合并);初始法线为"中性 (0,0,1)",未升级时与原渲染逐位一致。
2. `kickMwamUpgrade` → `terrain-mwam.ts loadMwamSlotTextures()`:经
   `TextureManager.getKtx2Loader()`(共享 loader,单文件构建下 URL 自动
   重映射到 `__ASSET_MANIFEST`)拉取每槽 albedo/normal.ktx2;
   **逐槽独立成败**:失败的槽位保留画布 —— 永不黑屏。
3. 成功纹理写 `mat.userData._mwamTex`(单点真值源)+ 换 live uniform,
   重编译(延迟模式开关)后从 `_mwamTex` 恢复,不丢升级。

## 5. 流水线(重跑/维护)

```bash
# 1) 从 UE .uasset 抠内嵌 PNG(mip0)→ textures-src/mwam/<layer>/*.png(不入库)
node scripts/extract-uasset-mips.mjs
#    — 输出 _extract-report.json;failed 列表走 UE 编辑器兜底:
#      在 UE5.8 打开 vngi1.uproject 后执行
#      scripts/export-mwam-from-ue.py(或 -run=pythonscript,见文件头注释)
# 2) 重映射法线通道(源 uasset 的 nrm 是 G/B 存 X/Y、R≈Z)→ 缩 1024² →
#    basisu ETC1S → public/textures/ktx2/terrain/<layer>/*.ktx2 + manifest
node scripts/mwam-import.mjs            # 可选 --size 512|2048 / --flip-green
# 3) 单文件构建自动内联 manifest.terrains 声明的通道
node scripts/build-single-html.mjs
```

> **踩坑记录(单文件 KTX2 全失效的根因)**:esbuild `format:'iife'` 会把
> `import.meta.url` 替换成空对象属性(undefined),three `KTX2Loader.js`
> 模块初始化里的 `new URL('../libs/basis/…', import.meta.url)` 直接抛
> TypeError → 动态 import 失败 → 飞机/地形 KTX2 全部静默回退画布(表现为
> "和以前一样"、看不出贴图生效)。已用 esbuild onLoad 插件把这行替换为空
> 串(该 URL 只在 `transcoderPath === ''` 分支使用,运行时恒走
> setTranscoderPath('/basis/'),补丁无副作用)。改 three 版本后若 KTX2Loader
> 源文件结构变化,记得同步核对 scripts/build-single-html.mjs 里的
> `ktx2-import-meta-fix` 插件正则。
> 另:地形材质在 loadSky 里创建、首帧编译却可能在数秒后(64 chunk 烘焙),
> 升级 kick 已改为"创建期 30s 轮询 + 编译回调内二次触发",两种时序都能启动。

法线源布局:载入 nrm 后均值 ≈ (R≈247, G≈128, B≈128)、R 方差小 —— 即
R 近乎常数(≈Z)、X/Y 在 G/B。导入时重排为 three 需要的 (R=X,G=Y,B=Z):
`out=(src.G, src.B, sqrt(1-X²-Y²))`,缩放后逐像素重归一化。若渲染发现
凹凸方向反转(凸变凹),用 `--flip-green` 重编码一次即可。
**法线尚未做过真机视觉校验** —— 跑任意山地任务看地表质感后决定是否
需要 --flip-green(见 §8 验收)。

## 6. 四合一地形改造(per user request: 分层修复 / 精度 / 高度图AO / PBR层参数)

### 6.1 分层修复(为什么之前"只有单一层")
旧 `splatAt` 用**名义 maxH 的相对高度** + 窄固定带(岩 0.45~snowLine、雪
>0.55),真实山地高度直方图质量集中在低区 → 某一带垄断全图;荒漠 vegi 带
0.08~1.0 单槽 → 整图一层沙。
现在(MWAM 风格路径):构建期做**全图高度普查**(~size/70m 网格缓存 + 512 桶
直方图分位 `q(p)`),分带边界取真实分布分位(terrain-mwam.ts `STYLE_CFG`:
mountain lowTop .05 / vegiTop .58 / rockTop .87;desert vegiTop .72 + snow
关闭 → 岩带爬顶;archipelago .6/.88),链式互补权重(和为 1),坡度 >0.62
部分转岩。**任务雪线覆盖不破坏**:engine 仅在 `mission.terrain.snowLine`
显式给出时传 `legacySnowLine`(T-00 全雪类),退回直接高度带(按普查真实
范围归一)。纯画布路径(terrainStyle=null)完全保持旧公式。

### 6.2 网格精度
LOD0 目标 ~55m/格:山岳 896 段 / 群岛 688 / 荒漠 1024(engine.ts 三处,
`mobileMode` 自动回退 336/280/320 ≈ 旧档)。LOD1-3 stride 网格与流式/LOD
morph 结构不变。代价:LOD0 顶点 ~1M、几何显存 +;loadSky 分帧让步已有。

### 6.3 高度图 AO(CPU 烘焙 per-vertex)
普查缓存双线性采样,每顶点 **6 方位(移动 3)×2 半径**(风格表 aoRadius:
山 380/1100m、荒漠 150/450m、群岛 220/660m)算邻域遮蔽
`ao = 1 - avg(max_occlusion) * 0.92`,钳 [0.35,1];terrain-v2 烘成 LOD0
场 → 各 LOD stride 双线性 → `ao` float attribute。shader 只在
`aomap_fragment` 后压**间接光**:`indirectDiffuse *= (1 - uMacroAO*(1-vAo))`,
与 relief AO 贴图相乘;直射/高光不受影响。强度 uMacroAO 按风格
(mountain .85 / archipelago .7 / desert .5 / plains .55);画布路径 0。

### 6.4 PBR 层参数
地形本就是 MeshStandardMaterial PBR 管线(逐像素法线/粗糙度/AO + PMREM
envMap IBL + 阴影),新增**层间 roughness 标量**:terrain-mwam.ts
`SHEET_ROUGHNESS`(dirt .92/grass 1.0/rock .68/sand .88~.9/snow .8/stones
.75),shader 在 `roughnessFactor` 处按 splat 权重混
`Σ vSplat·uLayerRough_i`(归一,随后仍乘 relief 粗糙图)。画布路径全槽
= .95 → 与旧渲染逐位一致。metallic 保持 0。

### 6.5 复测要点(真机/单文件)
- 山地:谷底土、大片草、中高岩、雪顶 **四带齐全**;山脚/谷底比之前暗 =
  AO 生效;阳光下岩/雪粗糙度反光差异可见。
- 荒漠:沙丘(sand_a/sand_c)+ 岩台双主层,不再一色。
- Console 期待:既有 `[terrain] MWAM …: KTX2 上线 +3 albedo +4 normal`,
  无 `anchor not found` 告警(出现 = three 版本漂移,回报)。
- 调参入口全部集中在 `terrain-mwam.ts`(STYLE_CFG 分位/半径/强度、
  SHEET_ROUGHNESS)与 engine.ts 三处 segments;`tilesize`/`memory` 控制台
  命令仍可用。加载若过重:降 segments 或调小 aoRadius/dirs。



## 7. 未接线资产与开关

- variation(normal.ktx2 已生成):宏法线 octave 的素材就绪,shader 接线
  被刻意留白(开关常量),避免首版引入额外 2 次采样。要启用:在
  `terrain-mwam.ts` 加 variation 槽 + `layered-terrain.ts` 注入第三 octave。
- cover_rocks / plants_grass:仅转码存档,等有"贴花/草片"渲染需求再接入。
- grass albedo(山地/群岛主植被层)在 5 张待兜底导出之列 —— 在 UE 里跑
  一次导出脚本后重跑 mwam-import 即补齐,运行时无需改动。

## 8. 验收(建议真机做一遍)

1. 山地任务:起飞后低空看地表 —— 贴图层应带真实草/土/岩/雪细节
   (日志出现 `[terrain] MWAM 山岳…: KTX2 上线 +4 albedo +4 normal`)。
2. 荒漠任务:应为沙丘/岩山观感(不再大范围绿)。
3. 若岩石/沙的凹凸方向像"凹陷反了",重编码:
   `node scripts/mwam-import.mjs --flip-green`(只影响法线)。
4. 控制台 `memory`:terrain KTX2 8 张活集 ≈ ≤2MB 显存;`tilesize` 调密度。
5. 单文件版(dist-single/index.html)离线双击:地形 KTX2 走内联 data URI,
   应同样出现升级日志(不出现 = 该环境 KTX2 不可用,画布兜底照常渲染)。
