# ACE / SKY — ace-mercenary

一个 Ace-Combat 风格的 3D 空战游戏：Next.js（App Router）+ React + three.js，可构建成**单文件 HTML** 分发（引擎、UI、关卡数据全部内联）。

## 特性

- **单文件分发**：`npm run build:single` 产出 `dist-single/index.html`（+ 可选 `assets/` 资产库），双击或静态托管即可运行。
- **物理包线飞控**：能量/过载/诱导阻力模型，失速、G 限、超音速阻力与机身抖振；键盘与鼠标两套操控（键鼠模式可分别调参）。
- **AC7 式导弹**：数据表驱动的弹种参数（MSL/LASM/QAAM/LAAM/SARH/…），两档限速率转向 + 转向耗能 + 重力、导引头视场、脱靶断制导；**无锁定也能发射（不可制导）**。
- **AI**：状态机（攻击/规避/脱离/高度带纪律）+ 机动库（破S/桶滚/蛇形/急转）+ 机炮偏差按速度插值 + 地形规避。
- **体积云 / 物理大气**：raymarched 体积云、云影级联、光柱；天空与光照按关卡预设（日/暮/雨/雷暴/夜）。
- **战役任务**：正式版剧情第一关 / 第二关（护航、波次、王牌中队、空中战舰与空爆弹）、无线电语音与字幕系统。
- **调试台**：控制台命令族（云/体积云/武器/天气/阶跃/重放等）+ CDP 无头验收探针（`scripts/_*.mjs`）。

## 快速开始

```bash
npm install            # 或 bun install
npm run dev            # 开发服务器 http://localhost:3000
npm run build:single       # 单文件构建 → dist-single/index.html
npm run build:single:dev   # 开发用（资产走真实 URL，便于探针）
node scripts/serve-test.mjs  # 本地静态服务 http://127.0.0.1:8898
```

### 资产说明（重要）

仓库**不含** `public/`（音频、模型、贴图、地形数据，合计数百 MB）。运行时/构建需要它们：

- 构建单文件：把资产放回 `public/`（保持目录结构）后执行 `npm run build:single`；
- 或者使用发布包里随行的 `assets/` 目录（与 `index.html` 同级、用 http 服务）。

没有资产时页面可以启动，但会出现无地形/无语音/无音乐等表现。

## 目录结构

```
src/lib/game/      引擎（飞控、武器、AI、云、大气、任务、电台…）
src/components/    HUD / 菜单 / 结算等 UI
src/app/           Next.js 入口
scripts/           构建（build-single-html.mjs）、资产导入、验收探针（_*.mjs）
docs/              设计与管线文档
```

## 许可

- **代码**：MIT（见 `LICENSE`）。
- **素材**：语音、音乐、模型、贴图、地形数据与工程源文件**保留所有权利**，不在 MIT 范围内（见 `LICENSE-ASSETS`）。
- 第三方素材保留其原始许可，署名见 `public/basis/README.md`、`public/draco/README.md`、`public/textures/veg/LICENSES.txt` 等。

## 致谢

- [three.js](https://threejs.org/)、[@takram/three-clouds](https://github.com/takram-design-engineering/three-geospatial)、Next.js / React、esbuild
- 植被贴片等 CC0 素材及其作者（见各目录许可文件）
