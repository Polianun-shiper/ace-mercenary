# FX 特效编辑�?3A 对标外壳 · 序列帧爆炸替换游戏原生特�?

> 与游戏本体的关系 = **UE 级联/尼亚加拉编辑�?�?UE 游戏**:独立应用�?> 独立入口、同一构建管线。编辑器创作�?*序列帧爆炸预设可以完全替换游�?> 原生爆炸视觉**(按「地�?f / 空中 4」槽�?,游戏发布�?*不依赖编辑器**:
> 预设(含内嵌图�?dataURL)�?`fx-tune.json` 融合链进单文�?双击即玩�?
## 1. 入口

| 形�?| 地址 |
|---|---|
| Next dev 路由 | `http://localhost:3000/fx-editor` |
| dev 静�?| `http://127.0.0.1:8898/editor/fx-editor.html`(`node scripts/serve-test.mjs`) |
| 单文�?| `dist-editor/fx-editor.html`(双击即用) |

## 2. 粒子系统核心(`src/lib/fx/fx-core.ts`)

- **实例化精灵四边形**:�?(混合模式 × 图集) 一�?InstancedMesh 一�?draw
  call 渲染全部粒子;自写 instanced sprite shader(`iColor` vec4 属性支�?  per-instance RGBA;`aFrame` 属�?+ `uGrid` uniform 支持**帧网格图�?  动画**,VS 内按帧折 UV 偏移)�?- **贴图两级**:缺省 = 程序化柔边圆�?共享);`SpriteEmitterCfg.sheet`
  可选帧网格图集 `{ dataUrl|url, cols, rows, frames }` —�?每粒子帧�?  �?`sheet.frames` �?帧按粒子寿命均分推进(CPU �?`t=age/life` 写帧�?
  �?iColor 每帧上传同模�?�?- **CPU 模拟**:速度/重力/阻力、寿命、尺寸与颜色随寿命线性插值、自旋�?  billboard;`play(asset, pos, baseDir?, {scale})` 支持整体倍率�?- **发射器三�?+ 闪光�?*:`sprite`(burst 爆发 / continuous 由调用方�?  `rate×dt` 逐颗�?`playEmitter`,每调用产 1 �?、`shockwave` 膨胀环�?  `lightflash` 点光�?- **池化**:2048-4096/�?按键 `(texKey|blend)` 分流,紧凑拷贝回收死粒�?
  `reset()` + 60fps 步进快进支持时间�?scrub;`prepareSheets(assets)` �?  解码图集(解码完成前对应发射器自动跳过,不报�?�?
## 3. 编辑器功�?
- 5 �?3A 演示预设:爆炸(火球+烟团+冲击�?闪光)、导弹尾烟、火花迸射�?  环形冲击波、烟尘�?- **导入序列�?顶栏)**:一次多选一组动画帧 PNG/JPEG/WebP(也可逐张多�?,
  按文件名**前缀 token 自动分组**:字母开�?`f001.png`…→ `f`)或数字开�?  (`4001.png`…→ `4`);组内按数字自然排�?a2 < a10)�?*每组(�? �?都会
  生成资产** —�?低帧数也直接兼容试效�?1 �?= 寿命内静止贴�?2-18 �?  自动慢放(寿命 �?.8s,每帧停留更久);�?9 帧按 24fps 标称时长。每组自�?  生成一�?FX 资产:**自动适配** = 单精灵爆�?×1、静�?速度 0)、寿命按�?  规则、帧按寿命均分播�?每帧等比缩到「帧边」档�?128/256/512,默认
  256)后排�?cols×rows 网格图集(RGBA PNG dataURL,�?4096 单边自动降档),
  `blend=additive`,双色�?尺寸 100。导�?toast 回显「分�?帧数/槽位/
  是否慢放」�?- **槽位分配**:f �?�?自动标「地面爆炸�?4 �?�?自动标「空中爆炸�?
  右侧资产面板可随时改(�?地面/空中)。同槽重复时导出按列表靠后者胜�?  (UI 有警告提�?�?- 发射�?Inspector 顶部图集�?缩略预览 / 帧数-网格-标称时长 / 移除序列�?  (回程序化圆点);「＋挂载序列帧」可把任意一组帧挂到已有精灵发射器上
  (自动对齐寿命)�?- 保存(localStorage `skybound.fx.assets`,序列帧超配额时提示改用导�?+
  导出 **`fx-tune.json`**(�?§4)�?- **A/B 对比模式(视口左上三键)**:「仅预设 / 仅原�?/ 原生 ◀ �?预设」�?  原生 = `weapons.ts spawnExplosion()` �?LOD 六层(闪光/火球/烟幕/冲击�?  �?火花×2 点光)�?*同参数独立复�?*(`src/lib/fx/legacy-explosion.ts`,
  scale 2),编辑器视口里就能直接对照「游戏现在的爆炸 �?准备替换的序列帧
  预设�?并排时左=原生、右=预设,共用同一时钟,拖时间轴可逐帧对比�?  地面序列帧在预览与游戏里同规则「踩地�?quad 底边贴命中面)�?- 左栏资产行显示槽位徽�?时间轴暂�?0.1-2×/循环/scrub(scrub 会重发射
  burst 与序列帧,不再空白);视口左键发射、右键环视、WASD+QE 飞行;选中
  带序列帧的资产会自动解码并播一次�?
## 4. 导出契约 = `fx-tune.json`(游戏侧融合链)

```jsonc
{
  "version": 1,
  "slots": { "ground": "fx-seq-1723-1", "air": "fx-seq-1723-2" },
  "assets": [
    {
      "version": 1, "id": "fx-seq-1723-1", "name": "序列帧爆炸[f]·地面",
      "loop": false, "slot": "ground",
      "emitters": [{
        "type": "sprite", "id": "e�?, "name": "序列帧主�?,
        "sheet": { "dataUrl": "data:image/png;base64,�?, "cols": 8, "rows": 6, "frames": 48 },
        "mode": "burst", "burstCount": 1, "lifetime": 2.0,
        "speed": 0, "spreadCone": 0, "size0": 100, "size1": 100,
        "color0": "#ffffff", "color1": "#ffffff", "opacity0": 1, "opacity1": 1,
        "blend": "additive", "spin": 0, �?      }]
    }
  ]
}
```

导出按钮会同时写�?`localStorage['skybound.fxTune']`(Next dev 热测)并下�?文件;**发布 = 把文件覆盖到 `public/config/fx-tune.json`,重新构建**�?
## 5. 游戏侧替换机�?已接�?�?未来")

- `src/lib/game/fx-tune.ts` = 加载模块(镜像 terrain-tune):localStorage
  `skybound.fxTune` �?`__ASSET_MANIFEST['/config/fx-tune.json']` dataURI
  (file:// 单文�?�?`fetch`。空�?�?assets)�?原生爆炸零变化�?- `src/lib/game/fx-battle.ts` `FxBattleLayer` = 运行�?`init(doc)` 取两�?  资产并预解码图集;`tryPlay(kind,pos,scale)` 预算(同时 �?0,超限吞掉�?  混跳)/视距(>14km 吞掉)/整体倍率 `clamp(scale,0.4,5)`;continuous 发射�?  (爆炸资产里的持续�?由内部持有表�?`rate×dt` 续发到资产播完�?- 钩子:`weapons.ts` �?`spawnExplosion` / `spawnCheapExplosion` 在既�?  视锥+距离剔除后先�?`onFxOverride`(engine 注入);**返回 true = 本次
  爆炸已被完全替换,原生 6 层视觉不再创�?*(音效/震屏/伤害均保留原�?�?- **归类规则**:engine `spawnFxReplacement` �?`_terrainHeightFn` 采样
  命中点地形高,`pos.y - 地形 > 25m` �?空中 4 �?否则地面 f 槽�?  机炮命中火花、水面溅射、核�?scale�? 底座)保持原生;核弹蘑菇云本�?  就是 engine 专有�?不参与替换�?- 逃生阀:`localStorage skybound.fxReplacement = 'legacy'` �?永远原生爆炸�?- 每帧:engine �?`weapons.update(...)` 后驱�?`fxBattle.update(dt, camera)`�?
替换规则速查�?

| 事件 | 归类 | 槽位 |
|---|---|---|
| 炸弹/导弹落地、地面单位被毁、舰船被毁、坠�?| 距地 �?5m | 地面 f |
| 击落敌机/盟友机、导弹空中命中、防空炮近炸 | 距地 >25m | 空中 4 |
| 机炮命中火花、水面溅射、核�?| �?| 原生保留 |

## 6. 发布(游戏脱离编辑器独立运�?

1. 编辑�?导入 f/4 序列�?�?检查槽�?�?导出 `fx-tune.json`�?2. 覆盖仓库 `public/config/fx-tune.json`�?3. `node scripts/build-single-html.mjs` —�?图集�?JSON 内联�?   `window.__ASSET_MANIFEST`(scripts/build-single-html.mjs ASSETS 已登�?   `/config/fx-tune.json`)�?4. 发布�?= `dist-single/index.html`(双击 file:// 可用,编辑器零依赖);
   服务器部署只传整个目�?含外�?4K HDRI)�?
- dev 静态服务器 `serve-test.mjs` 已把 `/config/` 加入 public 前缀(8898
  �?tune JSON 可用)�?- 体积护栏:单文�?~93MB(上限 ~100MB);两套 256px 图集�?+1-2MB(base64
  ×1.33)。素材过大建议帧�?128,或减少帧数�?
## 7. 实现结构

| 文件 | 职责 |
|---|---|
| `src/lib/fx/fx-core.ts` | 粒子系统 + FxAsset/sheet schema(契约) |
| `src/lib/fx/sheet-bake.ts` | 序列帧分�?自然排序/烘制纯函�?|
| `src/lib/fx/fx-world.ts` | 预览场景 + 图集预解�?|
| `src/components/fx/FXEditorApp.tsx` | 编辑�?UI(导入/槽位/图集 Inspector/时间�?导出) |
| `src/lib/game/fx-tune.ts` | 游戏�?JSON 融合�?镜像 terrain-tune) |
| `src/lib/game/fx-battle.ts` | FxBattleLayer(替换�?预算/续发/缩放/驱动) |
| `src/lib/game/weapons.ts` | `onFxOverride` 替换钩子 |
| `src/lib/game/engine.ts` | 归类判定 + 接线 + 逐帧驱动 + dispose |
| `src/standalone/fx-editor-entry.tsx` / `src/app/fx-editor/page.tsx` | 单文�?/ Next dev 入口 |
| `public/config/fx-tune.json` | 默认�?`{"version":1}`(游戏原生爆炸) |

## 8. 已知边界

- continuous 发射器需记录发射点并持续驱动(编辑�?游戏层各自实�?预览
  world �?FxBattleLayer 都按 rate×dt 续发)�?- 帧动�?= 单粒子按寿命均分;若要"前半段快速、尾段定�?,可复制发射器
  调不同寿�?帧偏移做叠层�?- scrub 快进�?60fps 步长,极长 duration 下精度有限�?- 尾迹/带状拖尾(ribbon)尚未实现;后续可加 `trail` 发射器类�?向后兼容)�?- 烘制只保留图�?dataURL,原始帧不存档 —�?想改档位需重新导入�?