<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 每次对话都要同步单文件 HTML（用户硬要求）

**每轮工作结束前必须重新构建单文件产物**，保证 html 与最新代码同步：

    node scripts/build-single-html.mjs --slim

产物：`dist-single/index.html`（要上传的就这一个）+ `dist-single/assets/`（随行资产库）。

要点（踩过的坑）：

- **大件一律随行**（用户明确要求）：地形/语音/贴图等大资产在 `src/lib/game/asset-library.json` 里登记为
  `copy: true` + `inline: false` + `external: true`；只有小配置才 `inline: true`。
  只上传 `index.html` 时没有 `assets/` ⇒ 地形、语音、贴图会全部缺失。
- **单文件 100MB 上限**：不加 `--slim` 是 ~109.7MB（超限传不上去）；`--slim`（= `--no-4k-sky`）把 4K 天空盒
  从内联里摘掉（仍随 `assets/` 发布）⇒ ~95MB。默认就用 `--slim`。
- 构建完**核对并汇报**：`dist-single/index.html` 的 MB 数、`dist-single/assets/` 的文件数。
- 构建**失败或被打断**必须明确说出来，不要让用户拿着半截产物去测。
- 编辑器产物（`dist-editor/`）同时产出，但与 `dist-single/` **平级**、不参与上传。
- `ffmpeg` 未安装时会跳过音频压缩（日志会提示）；装 `ffmpeg-static` 可再省一截体积。
