# 统一分层带(terrain bands)· 遮罩/材质带高透明化

> 需求背景:游戏山地高度不固定、分带高度不可见 → 岩层几乎占满遮罩;
> 且不知道"岩层到底从几米到几米"。本模块把「分带」收敛成一处、把「带高」
> 变成可查数据,并新增 nimbus 式垂直归一模式。

## 1. 统一解析器 `src/lib/game/terrain-bands.ts`

三种模式,全部输出**米**:

| 模式 | 含义 | 默认锚点 |
|---|---|---|
| `relative`(默认) | nimbus 式**垂直归一**:带高 = 实测高度域 minH..maxH 的百分比,不随山峰绝对高度漂移 | `REL_ANCHORS`(mountain 低 0.06 / 草 0.50 / 岩 0.82 …) |
| `quantile` | 面积分位(旧默认;每带占真实地表面积,不会一带领跑) | 各 style zones(lowTop .05 / vegi .58 / rock .87 …) |
| `absolute` | 固定海拔米(手动档) | `ABS_DEFAULTS`(mountain 300/1200/2600 …) |

- 调用方(全部同一函数,带高逐米一致):
  - 游戏 splat:`environment.ts` 的 `buildHeightmapTerrain` 模型 A(有 style 普查)
  - 遮罩自动生成/手绘底:`editor-world.ts maskWeights/bandReportOf`
  - 编辑器分层切片 `bandHeights()`(relative 也显示真实米)
- 结果经 `terrain.bands`(BandReport)返回:engine 存到 `(this as any)._terrainBands`,
  console 输入 `terrainbands`(或 `bands`)即打印:

```
TERRAIN BANDS [relative] 实测高度域 230..4320m
  低地/沙 < 470m  |  草 470..2275m  |  岩 2275..雪线 3584m 起
  软化半宽: ±164/±164/±164m | 面积占比: 低地 12.3% · 草 41.0% · 岩 33.2% · 雪 13.5%
```

- 陡坡转岩软化:默认改为 阈值 0.72 起、转移 0.65(旧 0.62/0.85 → 岩层泛滥缓解),
  可用 `terrain.slopeRockStart/slopeRockK`(tune/编辑器可选字段)调。

## 2. 岩层材质修正(只改岩层,不碰雾)

`layered-terrain.ts`:新增 `uRockBoost`(vec3 乘性校正,只按岩带权重 wS.z 生效):
默认 `1.18 / 1.09 / 0.98` —— 提亮 + 去蓝,KTX2 岩层贴图与程序化画布同生效;
`tune.material.rockBoost: [r,g,b]` 可覆盖;编辑器/控制台可经 `_tuneUniforms.uRockBoost` 实时调。
(远景的"雾洗成同色"问题仍由雾主导 —— 本次未动雾,需要时另开「封顶雾」。)

## 3. 默认与兼容

- 缺省 bandMode = `relative`(编辑器新项目与游戏无 tune 一致);旧 tune 里显式
  `quantile`/`absolute` 行为与旧版逐位等价(quantile 的米域平滑 = 原 u 域平滑,
  数学同构已核对)。
- 编辑器「分层基准」下拉新增 `相对域高(随山自适应)`。
- 类型:tune/editor `bandMode` 联合类型扩展、`slopeRockStart/slopeRockK`、
  `material.rockBoost` 均已加入并透传。
