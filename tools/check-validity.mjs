/**
 * 真实浏览器里校验表单约束：常见整数金额是否都被判为合法。
 * 需要完整权限（Chrome 的进程间通信被沙箱命名管道限制拦截）。
 *
 * 用法：node tools/check-validity.mjs
 * 依赖：本地预览服务器已在 4173 端口运行
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const URL_ = process.env.DCA_VALIDATE_URL || 'http://127.0.0.1:4173/?validate=1';
const LEGACY_URL = process.env.DCA_VALIDATE_LEGACY_URL || 'http://127.0.0.1:4173/?validate=legacy';
const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const exe = CANDIDATES.find((p) => fs.existsSync(p));
if (!exe) { console.error('没有可用浏览器'); process.exit(1); }

const profile = path.resolve('tools/.cache/chrome-profile');
fs.mkdirSync(profile, { recursive: true });

function dumpDom(url) {
  return new Promise((resolve) => {
    const args = [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-crashpad', '--disable-breakpad',
      '--disable-crash-reporter', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
      `--user-data-dir=${profile}`, '--window-size=1280,900',
      '--virtual-time-budget=7000', '--dump-dom', url,
    ];
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let html = '';
    child.stdout.on('data', (d) => { html += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('exit', () => resolve(html));
  });
}

/** 探针脚本源码本身也含有标记字符串，所以要求标记后紧跟一个 JSON 对象 */
function parseProbe(html) {
  if (!html) return null;
  const m = /DCA_VALIDATE_START(\{[\s\S]*?\})DCA_VALIDATE_END/.exec(html);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')); } catch { return null; }
}

function report(data, title) {
  console.log(`\n=== ${title} ===`);
  for (const f of data.fields) {
    console.log(`  ${f.sel}  step=${f.step}  min=${f.min}  max=${f.max}`);
    if (f.bad.length === 0) console.log('      ✓ 全部测试值均合法');
    else for (const b of f.bad) console.log(`      ✗ ${b.value} 被拒：${b.message}`);
  }
}

const main = async () => {
  // 第一步：对照实验 —— 把属性还原成修复前的 min=1 / step=100
  const legacyHtml = await dumpDom(LEGACY_URL);
  const legacy = parseProbe(legacyHtml);
  if (legacy) {
    report(legacy, '修复前（min=1 / step=100）的对照实验');
    console.log(`      → 共 ${legacy.invalid.length} 个常见整数被判非法，浏览器会弹提示并阻止提交`);
  } else {
    console.log('\n（对照实验未取到结果，跳过）');
  }

  // 第二步：当前代码
  const html = await dumpDom(URL_);
  const data = parseProbe(html);
  if (!data) { console.error('没有拿到校验结果（探针未执行？）'); process.exit(1); }
  report(data, '修复后（step=1）');

  if (data.invalid.length) {
    console.log(`\n❌ 有 ${data.invalid.length} 个"用户真会填"的值被判非法：`);
    for (const s of data.invalid) console.log('   - ' + s);
    process.exit(1);
  }
  console.log('\n✅ 常见整数金额全部合法，不会触发浏览器原生「请输入有效值」提示');

  // 回归意义：如果修复后仍然非法，或对照实验证明不了根因，都算失败
  if (legacy && legacy.invalid.length === 0) {
    console.log('⚠️ 对照实验没有复现出旧 bug，说明这个回归测试可能已经失效，需要重新检查');
    process.exit(1);
  }
};

main();

