# Gaea 预制地形导入工作流(自定义槽)

> 目标:把 Gaea(或其它的)预制地形接进现有地形体系 —— 编辑器内独立导入
> 窗口 → 高度/顶点色转成与既有系统一致的数据(外部高度场 + RGBA 遮罩 +
> 细节贴图远/近混合)→ 导出 terrain-tune → 游戏「custom」槽按包渲染。
> 具体做哪种地形由你后续发令。

## 1. 素材规范(v1)

| 输入 | 格式 | 说明 |
|---|---|---|
| 高度图 | 16/8-bit 灰度 PNG、EXR(单通道半浮点) | PNG 由编辑器内自写解析(pako inflate+反滤波);EXR 走 three EXRLoader。8-bit 会用值×幅度放大,建议 16-bit/EXR |
| 顶点色 | OBJ(`v x y z` 或 `v x y z r g b`) | 容错解析;色值 0..1 或 0..255 均收 |
| 可选 | — | 无顶点色时遮罩走「相对分带+坡度」自动生成 |

## 2. 编辑器:GAEA 导入窗口(EditorApp 顶栏按钮)

多步向导(独立 overlay,构建链零改动):
1. 素材选择(加载样例 / PNG / EXR / OBJ)。
2. 参数:世界尺寸(米)、幅度(0..1→米)、基准偏移(海面语义 0)、遮罩分辨率
   512/1024/2048、包名。
3. 远/近材质混合距离(实时拖):
   - 远(≥mixFar)≈ 导入**顶点色**直接上屏(稳定不闪);
   - 近(≤mixNear)= 遮罩选层**高清细节贴图 × 颜色校正**(vColor/规范色,
     钳 0.35..2.4),颜色连续;
   - 中间 smoothstep 过渡。
4. 「导入到自定义槽并预览」:顶点色按 4 层规范色卡软分类成 RGBA 遮罩
   (R/G/B/A = 低地/草/岩/雪,与既有 splat/遮罩通道一致),空格用相对分带
   +坡度兜底;高度场→双线性采样器;自动 rebuild 视口即见;遮罩可继续用
   现有手绘笔刷/自动生成微调。
5. 导出:顶栏「导出 terrain-tune.json」会把 custom 槽的
   `externalHeight`(.f32bin,<2MB 内嵌 base64;更大则提示放
   `public/custom-maps/<name>/heights.f32bin` 外置)+ maskPng 一并写进
   `maps.custom`。覆盖 public/config/terrain-tune.json + 重建即进游戏。

## 3. 游戏消费(custom 槽)

- 引擎 `loadSky` 新增 `mapType==='custom'` 分支:读 `maps.custom.terrain`:
  `externalHeight` 存在 → `loadExternalHeight`(bytesBase64 → 解码 / url →
  fetch+manifest)→ `buildExternalHeightAt` 双线性采样注入
  `buildHeightmapTerrain({heightAt})` —— 分块 LOD/survey/分带/AO/植被
  全自动跟随;材质 maskTexture 走既有遮罩通道;体积云带可由包指定
  (externalHeight.cloudBase/cloudTop,缺省 1800..3200)。
- 直达测试:`localStorage skybound.mapOverride='custom'` 后进任意任务
  (与 weatherOverride 同款);任务/出生点/目标入口等命令再接。
- 缺包/加载失败自动回退程序化默认(槽位始终可用)。

## 4. 关键文件

| 文件 | 职责 |
|---|---|
| `src/lib/terrain-import/height-source.ts` | Float32 米制网格:双线性 `buildExternalHeightAt`、f32bin 编解码、世界↔纹素换算 |
| `src/lib/terrain-import/classify.ts` | 顶点色→4 层 RGBA 遮罩(格 bin+软分类)+ 空格兜底 |
| `src/lib/terrain-import/loader.ts` | tune `externalHeight` 运行期加载(内嵌/外置/单文件 manifest) |
| `src/lib/editor/gaea-import-decode.ts` | 编辑器专用:PNG-16(pako)、EXR、OBJ 解析 + 样例生成器 |
| `src/components/editor/GaeaImportDialog.tsx` | 导入窗口(多步 UI + 导入执行) |
| `src/lib/editor/editor-world.ts` | external 运行时数据挂载/导出;rebuild 注入 heightAt + 顶点色远/近 |
| `src/lib/game/environment.ts` | `HeightmapTerrainOpts.heightAt/externalVertex` 注入 |
| `src/lib/game/pbr/layered-terrain.ts` | 顶点色远/近混合(uniform uVtxMode…,缺省关零回归) |
| `src/lib/game/engine.ts` | custom 分支 + mapOverride + 包解析 + 云带 |
| `src/lib/terrain-import/transform.ts` | 逐图层对齐(`MapTransform` / `applyGridTransform` / `transformImageToCanvas`,顺序 flipY→flipX→rotCW) |
| `scripts/gaea-png-pack.mjs` | **v2 主路径**:Gaea 四件套 PNG(4096²)→ 2048² f32bin/color.jpg/normal.png/ao.png + 合并 tune |
| `scripts/gaea-import.mjs` | EXR/PNG16 高度 → f32bin(tune 合并),含 `preview` 只读预览 |
| `scripts/gaea-color-import.mjs` / `gaea-normal-import.mjs` | ColorExport EXR(BGR 平面序)→ PNG;高度 EXR → 切线法线 |

## 5. 已知边界(v1 骨架)

- 编辑器项目保存/重载不保留高度/顶点色大 payload(会话内数据;重载需重导
  入或把外置包放回 public/custom-maps/)。
- OBJ 顶点坐标按「米 + 相对世界中心」解释;真实 Gaea 导出若尺寸/镜像
  不符,拿样例后按命令微调解析/变换。
- 顶点色近景颜色校正 = vColor/Σ(w·规范色),色调匹配是近似;要更精细可把
  色卡换成本地规范贴图平均色。
- 大包(>2MB 高度网格)单文件 file:// 无法内嵌,用 512² 以下分辨率或外置目录。

## 6. v2:四件套 PBR 路径 + 逐图层手动对齐(2026-09,当前主线)

> 实际用的不是"顶点色",而是 Gaea 导出的**整图基础色/法线/AO**:`externalVertex{mixNear:0,mixFar:0}` 让色图完全接管 albedo,法线/AO 作为独立贴图挂材质。

**打包(离线)** `node scripts/gaea-png-pack.mjs <四件套目录>`
- 输入 4096² 8bit:`HeightmapExport.png`(黑=低/白=高)、`ColorExport.png`、`NormalsExport.png`、`AOExport.png`。
- 输出(均 2048²,双线性降采样):`public/custom-maps/custom/{heights.f32bin, color.jpg, normal.png, ao.png}` + `manifest.json` + 合并 `public/config/terrain-tune.json`。
- 高度映射:黑 0 → 0m,白 → `maxHeight`(4320);`segments:1792` 抬高 LOD0 密度。

**tune 结构**(`maps.custom`)
```json
"terrain": { "externalHeight": {"kind":"f32bin-gzip","size":48600,"resX":2048,"resY":2048,
                               "maxHeight":4320,"url":"/custom-maps/custom/heights.f32bin.gz"},
             "mode":"mountain","bandMode":"relative","segments":1792 },
"material": { "colorMap":"/custom-maps/custom/color.jpg",
              "normalMap":"/custom-maps/custom/normal.jpg",
              "aoMap":"/custom-maps/custom/ao.jpg" },
"transform": { "height":{"rot":270}, "normal":{"rot":90}, "color":{"rot":90,"flipX":true} }
```
- **高度场 gzip(`kind='f32bin-gzip'`)**:2048² 高度网格 `gzip -9` 压 **23.5×**(16MB → 0.68MB),
  运行时 `loadExternalHeight` 用 pako `inflate`(自动识别 gzip)再 `decodeF32Bin`,**零精度损失**。
  `kind` 缺省时按 url 是否 `.gz` 自动判断;老 `kind='f32bin'` 仍兼容。这是单文件体积的头号优化(§62)。
- **材质 JPEG**:color 用 q88,normal q90、ao q86(`scripts/gaea-material-jpeg.mjs`,sharp `4:4:4`+mozjpeg)。
  2048² 地表上肉眼无差,PNG → JPEG 省约 12MB;`--revert` 可还原 PNG。

**逐图层对齐(核心)**
- `transform.<layer>` = `{rot:0|90|180|270, flipX, flipY}`,顺序 **flipY → flipX → rotCW**;高度场与贴图共用同一约定,否则贴图与地形错位。
- 引擎:`engine.resolveExternal(url,prefix,srgb,mTune,label,layerTf)` 统一加载三图并按 tf 重绘成 `CanvasTexture`(缓存 key 含 tf);高度场走 `applyGridTransform`。
- 编辑器:顶栏 `▶ 测试 004 导入地形`(读 tune 全盘预览)+ 图层按钮 **高度/基础色/法线/AO** + `↻90° / ⇋X / ⇅Y / 复位`,**每层独立**调,改动即刻重建视口;修正保存在编辑器项目 JSON(优先级高于 tune)。
- Gaea 侧导出名与 UE 约定:见 `DEVELOPMENT.md` §56/§57(含 `.terrain` 文本拼接规则、无头 Swarm 与 license 上限 ≤1024²)。

**单文件/file://**
- `build-single-html.mjs` 把 `/custom-maps/custom/*` 四件套一并内联(存在才加),故 file:// 双击也能看到新地形;`readAsset` 门限 64MB。
