/**
 * 静态一致性检查：把 app.js 里用到的所有 DOM 选择器与 index.html 里的 id/class 对照，
 * 防止"改了 HTML 忘了改 JS"这种只在浏览器里才炸的低级错误。
 * 用法：node tools/check-dom.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const html = await fs.readFile(path.join(ROOT, 'docs', 'index.html'), 'utf8');

const files = ['app.js', 'chart.js', 'compute.js', 'achievements.js', 'decode.js'];
const sources = {};
for (const f of files) {
  sources[f] = await fs.readFile(path.join(ROOT, 'docs', 'js', f), 'utf8');
}

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const htmlClasses = new Set(
  [...html.matchAll(/\bclass="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/).filter(Boolean))
);

const problems = [];
let checked = 0;

for (const [file, src] of Object.entries(sources)) {
  // $('#foo') / $$('#foo') / querySelector('#foo')
  for (const m of src.matchAll(/(?:\$|querySelector|querySelectorAll)\(\s*['"]#([A-Za-z0-9_-]+)['"]/g)) {
    checked++;
    if (!htmlIds.has(m[1])) problems.push(`${file}: 选择器 #${m[1]} 在 index.html 中不存在`);
  }
  // $('.foo')
  for (const m of src.matchAll(/(?:\$|querySelector|querySelectorAll)\(\s*['"]\.([A-Za-z0-9_-]+)['"]/g)) {
    checked++;
    // 有些类是 JS 动态生成的，允许出现在 CSS 或本文件里
    const cls = m[1];
    const inHtml = htmlClasses.has(cls);
    const inSource = new RegExp(`class="[^"]*\\b${cls}\\b`).test(src) || new RegExp(`className\\s*=\\s*['"][^'"]*\\b${cls}\\b`).test(src);
    if (!inHtml && !inSource) problems.push(`${file}: 选择器 .${cls} 既不在 index.html 也不在动态生成的 class 里`);
  }
}

// 反向检查：HTML 里声明了但 JS 从不使用、且看起来像是占位的关键 id
// 这些 id 只用于语义标注（锚点、无障碍），不参与脚本逻辑，属于允许保留的名单
const ID_ALLOWLIST = new Set(['form-panel', 'result-anchor']);
const criticalIds = [...htmlIds].filter((id) => !id.startsWith('start-') && !id.startsWith('end-') && !ID_ALLOWLIST.has(id));
const usedText = Object.values(sources).join('\n');
for (const id of criticalIds) {
  if (!usedText.includes(`#${id}`) && !usedText.includes(`"${id}"`) && !usedText.includes(`'${id}'`)) {
    problems.push(`index.html: #${id} 定义了但没有任何 JS 引用（可能是改名后遗留）`);
  }
}

// 检查模块之间的 import 是否都能在磁盘上找到
for (const [file, src] of Object.entries(sources)) {
  for (const m of src.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)) {
    const target = path.join(ROOT, 'docs', 'js', m[1]);
    try {
      await fs.access(target);
    } catch {
      problems.push(`${file}: import '${m[1]}' 对应的文件不存在`);
    }
  }
}

// 检查 index.html 引用的资源是否存在
for (const m of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
  if (m[1].startsWith('data:')) continue;
  try {
    await fs.access(path.join(ROOT, 'docs', m[1]));
  } catch {
    problems.push(`index.html: 引用的资源不存在 ${m[1]}`);
  }
}

console.log(`检查了 ${checked} 个选择器、${htmlIds.size} 个 id、${htmlClasses.size} 个 class`);
if (problems.length) {
  console.log(`发现 ${problems.length} 个问题：`);
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('DOM 引用与资源引用一致性检查通过');
