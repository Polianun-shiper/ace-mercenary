# VibeHub 协作许可 / VibeHub Collaboration License

本文件声明 **ACE / SKY（ace-mercenary）** 项目在 VibeHub 平台上的协作与使用条款。
（VibeHub 项目标识：`P06Yl-WF` · 平台地址 `https://vibe.lumigrav.space` · 联机 SDK `https://gamesvibe.app/sdk/v3/vibehub.js`）

## 1. 代码授权（Code）

本仓库**源代码**按 [MIT](LICENSE) 授权：可自由使用、修改、分发、商用，需保留版权声明与许可文本。

## 2. 素材授权（Assets — 保留所有权利）

以下内容**不在 MIT 范围内**，未经书面许可不得再分发、商用或用于训练数据集（详见 [LICENSE-ASSETS](LICENSE-ASSETS)）：

- `public/audio/**` 语音、音乐、音效
- `public/models/**`、`public/textures/**`、`public/custom-maps/**` 模型、贴图、地形数据
- `blender/**`、`download/**` 工程源文件与离线素材

第三方素材保留其原始许可与署名（见 `public/basis/README.md`、`public/draco/README.md`、`public/textures/veg/LICENSES.txt` 等）。

## 3. 协作规则（Collaboration）

1. **欢迎**：Issue、PR、关卡数据、UI/文档改进；PR 请基于默认分支、保持单一主题、说明动机与验证方式（本项目习惯用 `scripts/_*.mjs` 无头验收探针给出证据）。
2. **禁止**：再分发第 2 节的素材；把本项目改成"仅换皮"的同质竞品；移除版权与许可声明后发布。
3. **署名**：基于本仓库的衍生作品请在 README 注明来源（`Polianun-shiper/ace-mercenary`）。
4. **平台自动化**：VibeHub 的自动化会在 `vibehub/setup` 分支准备改动、在 `vibehub/automation` 分支提交构建产物；项目元数据位于 `.vibehub/project.json`。请勿手工重写默认分支历史，以免覆盖自动化写入的文件。
5. **AI/自动化贡献**：允许；但提交者需对内容负责，且不得提交未授权素材。

## 4. 商标与名称

项目名称、Logo、关卡与角色文本的著作权与商标权保留。

## 5. 变更

本许可的更新以本文件在默认分支上的最新版本为准。

---

Project: **ACE / SKY — ace-mercenary**  ·  Maintainer: **Polianun-shiper**
