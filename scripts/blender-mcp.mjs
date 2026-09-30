#!/usr/bin/env node
// scripts/blender-mcp.mjs
//
// 直连 Blender 的 MCP 桥(Blender 5.2 官方插件 "MCP", 在 Blender 内起一个 TCP 服务)。
//
// 为什么不用官方 MCP server 进程:
//   这个插件本身就是**服务端** —— localhost:9876, 收 NUL 结尾的 JSON
//   ({"type":"execute","code":"<python>","strict_json":true}), 在 Blender 主线程里
//   直接 exec 那段 Python, 再把 {"status":"ok","result":{...}} 用 NUL 结尾写回。
//   协议就这么简单, 所以不必再装 MCP server / MCP 客户端桥, 一个小脚本直连即可。
//   参考实现: <Blender>/5.2/extensions/user_default/mcp/mcp_to_blender_server.py
//
// 用法:
//   node scripts/blender-mcp.mjs --ping                 # 探活
//   node scripts/blender-mcp.mjs --file probe.py        # 跑一个 .py 文件
//   node scripts/blender-mcp.mjs --code "result = {'v': 1}"
//   node scripts/blender-mcp.mjs --ping --port 9876 --host localhost
//
// 怎么让 Blender 那边把服务起起来(二选一):
//   A. GUI(推荐, 支持 check_is_finished 长任务):
//      正常启动 Blender → 系统设置里打开「在线访问(online access)」→
//      插件 MCP 的 Auto Start 默认开, 启动约 1s 后监听 9876。
//      ★ 注意: `--factory-startup` 会禁用用户插件, 桥就起不来了。
//   B. 后台模式(不支持延迟响应, 单个请求必须同步跑完):
//      blender -b <file.blend> --command blender_mcp --online-mode
//
// 与 headless 烘焙的分工(见 docs/vfx-bake-pipeline.md):
//   · 桥 → 短请求: 探针、改参数、渲 1~4 张预览、出接片(单请求别超过 ~30s)
//   · headless CLI(blender -b --python) → 正式烘焙, 可复现、可进 CI
//   桥在后台模式下**不支持** check_is_finished 延迟响应, 长任务请走 CLI。

import { readFileSync } from 'node:fs';
import { connect } from 'node:net';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i < 0 ? d : (argv[i + 1] ?? true);
};
const has = (n) => argv.includes('--' + n);

const HOST = flag('host', 'localhost');
const PORT = parseInt(flag('port', '9876'), 10);
const TIMEOUT_MS = parseInt(flag('timeout', '120000'), 10);

function buildCode() {
  if (flag('file')) return readFileSync(flag('file'), 'utf8');
  if (flag('code')) return flag('code');
  return null;
}

/** 一次请求/响应: NUL 分隔的 JSON。 */
function call(code) {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: HOST, port: PORT });
    let buf = '';
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); try { sock.destroy(); } catch {} } };

    sock.setTimeout(TIMEOUT_MS, () => done(reject, new Error(
      `等 ${TIMEOUT_MS}ms 没等到响应(Blender 可能卡在渲染里; 长任务请走 headless CLI)`)));
    sock.on('error', (e) => done(reject, e));
    sock.on('connect', () => {
      sock.write(JSON.stringify({ type: 'execute', code, strict_json: true }) + '\0');
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const i = buf.indexOf('\0');
      if (i < 0) return;
      const raw = buf.slice(0, i);
      try { done(resolve, JSON.parse(raw)); }
      catch (e) { done(reject, new Error('响应不是合法 JSON: ' + raw.slice(0, 500))); }
    });
    sock.on('close', () => {
      if (!settled) done(reject, new Error('连接在收到完整响应前被关闭'));
    });
  });
}

async function main() {
  if (has('ping')) {
    try {
      const r = await call("import bpy\nresult = {'blender': bpy.app.version_string, "
        + "'background': bool(bpy.app.background), 'file': bpy.data.filepath or None}");
      console.log('OK 桥在线:', JSON.stringify(r));
      process.exit(0);
    } catch (e) {
      console.error('桥不可达 (' + HOST + ':' + PORT + '):', e.message);
      console.error('检查: Blender 是否在跑? 系统设置里 online access 是否打开?');
      console.error('      插件 MCP 的 Auto Start 是否开着? 不是用 --factory-startup 起的?');
      process.exit(1);
    }
  }

  const code = buildCode();
  if (!code) {
    console.error('用法: node scripts/blender-mcp.mjs --ping | --file <x.py> | --code "<python>"');
    process.exit(2);
  }

  const r = await call(code);
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : r.stdout + '\n');
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : r.stderr + '\n');
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.status === 'ok' ? 0 : 1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
