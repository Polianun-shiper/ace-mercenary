// 删完云切片后的一条命令: 重建图集 + 刷新索引 + 重出单文件产物。
//   node scripts/clouds-apply.mjs            # 全套
//   node scripts/clouds-apply.mjs --no-build # 只重建图集与索引(不出 HTML)
//
// ⚠️ 不要用 clouds-prep.mjs 代替本脚本: 它会从 `_raw/` 重新切出**全部**切片,
//    把你删掉的那些又装回来(那个脚本的用途是从原始联络表重新切片/重新分类)。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const noBuild = process.argv.includes('--no-build');

const run = (script, extra = []) => {
  console.log(`\n$ node scripts/${script} ${extra.join(' ')}`.trimEnd());
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...extra], {
    cwd: ROOT, stdio: 'inherit',
  });
  if (r.status !== 0) { console.error(`✗ ${script} 失败 (exit ${r.status})`); process.exit(r.status ?? 1); }
};

run('clouds-atlas.mjs');     // 按当前目录里的切片重打图集(删掉的自然不进图集)
run('clouds-index.mjs');     // 刷新带序号的联络图 + index.md
if (!noBuild) run('build-single-html.mjs');   // 出 dist-single/index.html (+ assets/)

console.log('\n完成。上传: dist-single/index.html + dist-single/assets/ (云的随行资产仍是图集 3 个文件)。');
