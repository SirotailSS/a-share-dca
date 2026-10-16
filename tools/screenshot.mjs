/**
 * 用系统浏览器对本地预览页截图，供人工核对渲染效果。
 * 为什么绕这一圈：DSH 沙箱会拦截 Node 捕获子进程输出的命名管道，
 * 所以这里必须用 stdio: 'inherit'（不捕获输出），否则 spawn 会直接 EPERM。
 *
 * 用法：node tools/screenshot.mjs [输出文件] [窗口宽] [窗口高] [url]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] || path.resolve('tools/.cache/shot.png');
const width = process.argv[3] || '1440';
const height = process.argv[4] || '2600';
const url = process.argv[5] || 'http://127.0.0.1:4173/';

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const exe = CANDIDATES.find((p) => fs.existsSync(p));
if (!exe) {
  console.error('找不到 Chrome 或 Edge，无法截图');
  process.exit(1);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });

const profile = path.resolve('tools/.cache/chrome-profile');
fs.mkdirSync(profile, { recursive: true });

const args = [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-crash-reporter',
  '--disable-breakpad',
  '--disable-dev-shm-usage',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`,
  '--virtual-time-budget=8000',
  `--screenshot=${out}`,
  url,
];

console.log(`浏览器：${exe}`);
console.log(`目标：${url}  尺寸：${width}x${height}`);
console.log(`输出：${out}`);

const child = spawn(exe, args, { stdio: 'inherit', windowsHide: true });
child.on('error', (err) => {
  console.error('启动失败：' + err.message);
  process.exit(1);
});
child.on('exit', (code) => {
  if (fs.existsSync(out)) {
    console.log(`截图成功，${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
    process.exit(0);
  }
  console.error(`浏览器退出码 ${code}，未生成截图`);
  process.exit(1);
});
