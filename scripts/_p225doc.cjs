// §225 文档落盘工具(留档: 以后追加章节直接照这个来)
//
// 本项目两份大文档是 **GBK** 编码, 交接文件是 **UTF-8**; Node 内置没有 GBK 编码器
// (只有 TextDecoder('gbk') 能解不能编), 所以 GBK 那两份走 PowerShell:
//   [System.IO.File]::AppendAllText(<目标>, <UTF8 读进来的字符串>, [Encoding]::GetEncoding(936))
// 见 .shots/_app225.ps1。交接文件按轮次**倒序**, 新条目要插在 §213 之前, 标题格式 `### §NNN 标题`。
//
// 用法: 先写 .shots/_sec225_dev.md / _sec225_wl.md / _sec225_handoff.md 三个 UTF-8 片段, 再:
//   node scripts/_p225doc.cjs            # 只插交接文件(UTF-8, 原地)
//   powershell -File .shots/_app225.ps1  # 追加两份 GBK 文档
const fs = require('fs');

const HANDOFF = 'DSH_HANDOFF.md';
const frag = '.shots/_sec225_handoff.md';
const anchor = '### §213 F-16C 的自动法线平滑只留给机身大表面蒙皮';

let h = fs.readFileSync(frag, 'utf8').trim();
h = h.replace(/^#{2,4}\s*§?225[.、]?\s*/, '### §225 ');
const t = fs.readFileSync(HANDOFF, 'utf8');
if (t.includes('### §225 ')) {
  console.log('§225 已在交接文件里, 跳过');
} else if (!t.includes(anchor)) {
  console.error('插入锚点没找到(交接文件的标题被改过?)');
  process.exit(1);
} else {
  fs.writeFileSync(HANDOFF, t.replace(anchor, h + '\n\n' + anchor), 'utf8');
  console.log('§225 已插到 §213 之前');
}
