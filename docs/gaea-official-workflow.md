# Gaea 2 官方工作流速查（从官方文档学来的，用于给 Blender 地形出图）

> 目的：以后**照官方文档连节点**，不再凭我们自己的 schema 猜端口（那是之前"图连得差"的根因）。
> 来源全部是 QuadSpinner 官方资料 ✓（见文末链接）。

## 一、官方推荐的**节点链**（山区地形）

```
Mountain                        ← 基础山形(数学生成)
  → Adjust (Shaper = 放大/撑开山体, "bulk up / more expansive")
  → Erosion_2                     ← 主力侵蚀: 一侧出深沟、另一侧出矿物沉积缓坡
  → Thermal_2                     ← 热力侵蚀: 打散碎石坡/收敛过陡坡面
  → Sandstone / Outcrops / FractalTerraces   ← 岩层质感(用**按海拔遮罩**限制在高处)
  → TextureBase → SatMap → ColorErosion      ← ★ 上色: 基础色→卫星色图→沿侵蚀流"渗色"
  → (Snowfall)                    ← 雪(高海拔)
```

**关键点**（我此前完全没做的那部分）：

1. **上色是独立的三段**：`TextureBase`（建立色彩基础）→ `SatMap`（1400+ 张官方卫星色图，按地理风格挑）→ `ColorErosion`（让颜色**沿侵蚀流方向渗开**，这是"看起来真实"的关键 ✓）。
   ⚠ 有社区经验：**导出到引擎前要把 `ColorErosion` 摘掉**（它偏渲染层效果），我们做 Blender 预览可以留、做游戏贴图时视情况摘。
2. **细节层都要"按海拔遮罩"**（Sandstone/Outcrops 之类只长在一定高度带），不是全图无差别叠加。
3. **Adjust 的 `Shaper`** 是控制轮廓气质的第一道手（撑开、压扁、拉高），不是可跳过的节点。
4. 官方对"怎么用"的表述是：**先造形(shape) → 再调形(adjust) → 再上模拟(erosion 等)**，图就是这条流程的流程图。

## 二、我们的图缺什么（对照结论）

我们现在的 `blender/terrain/06_make_gaea_graph.py` 走的是"程序化噪声叠加 + 自己的分带/调色"，**没有**官方的上色三段（`TextureBase → SatMap → ColorErosion`）与 `Adjust/Shaper` 这道塑形 ⇒ 这正好解释了历史上的两个抱怨：

- "**没有基础色啊**" / "山地基础色看着一点都不像真实的雪山" ⇒ 缺 `SatMap` 那一环（真实的卫星色纹理）；
- "**怎么是沙漠**，我要的是西欧平原" ⇒ 缺 `TextureBase`（它负责给整片地形一个**生物/气候基底**），于是颜色只由我们自己的噪声分带决定，跑出沙色。

## 三、官方文档位置与抓取方式（重要）

| 用途 | 地址 |
|---|---|
| 官方文档站 | `https://docs.gaea.app/` |
| Starter Guide（入门） | `https://docs.gaea.app/using/getting-started/` |
| **文档源码（markdown，可直接抓原文）** | `https://raw.githubusercontent.com/QuadSpinner/Gaea2-Docs/refs/heads/working/source/<path>` |
| 官方深潜视频（Yukon River Valley，含 Erosion2/Rivers/Snow/Texturing 分章） | `https://docs.gaea.app/videos/official/deepdives/yt-yukon-river-valley.html` |
| 官方社区教程（Eroded Hoodoos 等） | `https://docs.gaea.app/videos/community/...` |

**节点参考的组织方式**（已确认）：仓库里按**节点分类目录**放，形如
`source/.data/reference/nodes/<category>/<node>/…`，已见分类有 `colorize`（cluter/colorerosion/satmap/supercolor/synth/watercolor…）与 `modify`（autolevel/blur/shaper/warp/threshold…）⇒ 要每个节点的**端口与参数**，按 `source/reference/nodes/<category>/<node>.md` 逐个抓即可（一次抓十几个我们实际用到的就够）。

## 四、下一步（按这个顺序做）

1. 抓官方参考：**我们实际用到的十几个节点**的 markdown ⇒ 写成 `docs/gaea-nodes.md`（端口 + 参数 + 默认值）；
2. 按官方链路**重写 `06_make_gaea_graph.py`**：补上 `Adjust(Shaper)` 与 `TextureBase → SatMap → ColorErosion`，细节层改成"按海拔遮罩"；
3. 用 `F:\Gaea 2\Gaea.Server.exe`（本地服务器）或 `Gaea.BuildManager.exe`（批构建）跑通 ⇒ 导出高度/色彩/掩码；
4. 进 Blender 做预览（你亲自验收）⇒ 通过后再进烘焙/游戏；
5. 最后用官方 `skill-creator` 打包成 **`gaea-terrain` 技能**：把上面的链路、参数表、产物校验（高度范围/分位/色彩空间/世界域坐标）固化，避免以后再"猜着连"。

## 五、来源

- [Starter Guide — Gaea Documentation](https://docs.gaea.app/using/getting-started/)
- [Starter Guide 源码（markdown）](https://raw.githubusercontent.com/QuadSpinner/Gaea2-Docs/refs/heads/working/source/using/getting-started/index.md)
- [Yukon River Valley 官方深潜（Mackenzie 山脉）](https://docs.gaea.app/videos/official/deepdives/yt-yukon-river-valley.html)
- [官方社区教程 Master of Gaea — Eroded Hoodoos](https://docs.gaea.app/videos/community/Polyboost/ILJiLjsS4V4.html)
- [Gaea → Unreal Engine 5 实现指南（Qiita，提到导出前移除 ColorErosion）](https://qiita.com/dorayaki800/items/90b91994db9d8b893d03)
- [Reproducing Real Mountain Terrain in Gaea Using Actual Geology (Part 1)](https://indyzone.co.jp/archives/22354)
- [QuadSpinner Gaea Tutorial — High Mountain](https://indyzone.co.jp/archives/15902)
