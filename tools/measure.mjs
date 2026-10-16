/**
 * 真实浏览器的布局回归：量测不同视口下的横向溢出与关键尺寸。
 * 需要完整权限（Chrome 的进程间通信被沙箱命名管道限制拦截）。
 *
 * 用法：node tools/measure.mjs
 * 依赖：本地预览服务器已在 4173 端口运行（node tools/serve.mjs 4173）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.DCA_URL || 'http://127.0.0.1:4173/?measure=1';
const VIEWPORTS = [
  { name: '手机-小屏', w: 360, h: 900 },
  { name: '手机-常规', w: 414, h: 900 },
  { name: '平板', w: 768, h: 1000 },
  { name: '笔记本', w: 1280, h: 900 },
  { name: '桌面', w: 1440, h: 1000 },
];

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const exe = CANDIDATES.find((p) => fs.existsSync(p));
if (!exe) { console.error('没有可用浏览器'); process.exit(1); }

const profile = path.resolve('tools/.cache/chrome-profile');
fs.mkdirSync(profile, { recursive: true });

function run(w, h) {
  return new Promise((resolve) => {
    const args = [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-crashpad', '--disable-breakpad',
      '--disable-crash-reporter', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
      `--user-data-dir=${profile}`, `--window-size=${w},${h}`,
      '--virtual-time-budget=7000', '--dump-dom', BASE,
    ];
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('exit', () => {
      const m = /DCA_MEASURE_START([\s\S]*?)DCA_MEASURE_END/.exec(out);
      if (!m) { resolve(null); return; }
      try { resolve(JSON.parse(m[1])); } catch { resolve(null); }
    });
  });
}

const results = [];
for (const v of VIEWPORTS) {
  const r = await run(v.w, v.h);
  if (!r) { console.log(`  ? ${v.name} (${v.w}px) 量测失败`); results.push({ v, r: null }); continue; }
  const overflowPx = r.scrollWidth - r.clientWidth;
  const flag = overflowPx > 1 ? '溢出' : 'OK';
  console.log(`  ${flag} ${v.name} (${v.w}px)  视口=${r.clientWidth} 内容=${r.scrollWidth}` + (overflowPx > 1 ? `  横向溢出 ${overflowPx}px，${r.overflow.length} 个元素越界` : ''));
  if (r.overflow.length) {
    for (const o of r.overflow.slice(0, 8)) {
      console.log(`        ${o.tag}${o.id ? '#' + o.id : ''}${o.cls ? '.' + o.cls.split(/\s+/).join('.') : ''}  left=${o.left} right=${o.right} w=${o.width}  "${o.text}"`);
    }
  }
  results.push({ v, r });
}

const bad = results.filter((x) => x.r && x.r.scrollWidth - x.r.clientWidth > 1);
console.log(`\n布局检查：${results.length - bad.length}/${results.length} 个视口无横向溢出`);
fs.writeFileSync(path.resolve('tools/.cache/measure.json'), JSON.stringify(results, null, 2), 'utf8');
process.exit(bad.length ? 1 : 0);
