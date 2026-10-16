#!/usr/bin/env node
/**
 * 极简本地静态服务器（只为本地预览，生产环境用 GitHub Pages）。
 * 用法：node tools/serve.mjs [port]   默认 http://127.0.0.1:4173
 * 说明：页面本身用 file:// 直接双击也能跑（数据库是 <script> 加载的），
 *       这个服务器只是为了让 ES module 的 MIME 类型、缓存行为与线上一致。
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(path.resolve(__dirname, '..'), 'docs');
const PORT = Number(process.argv[2] || process.env.PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel.endsWith('/')) rel += 'index.html';
    const full = path.join(ROOT, rel);
    // 目录穿越防护
    if (!full.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let data = await fs.readFile(full);
    const ext = path.extname(full).toLowerCase();

    // ?measure=1 只给本地预览用：往 HTML 里注入一段量测脚本，
    // 把页面宽度与溢出元素写进 DOM，方便配合 --dump-dom 做布局回归。
    // ?validate=1 则注入表单约束校验探针，验证 amount 之类的输入框
    // 对常见整数是否都合法（step/min 组合写错时浏览器会直接弹「请输入有效值」）。
    // 生产代码 docs/index.html 完全不受影响。
    if (ext === '.html' && url.searchParams.get('measure') === '1') {
      data = Buffer.from(injectProbe(data.toString('utf8')), 'utf8');
    } else if (ext === '.html' && url.searchParams.get('validate')) {
      data = Buffer.from(
        injectValidator(data.toString('utf8'), url.searchParams.get('validate') === 'legacy'),
        'utf8'
      );
    }

    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
});

/** 注入布局量测探针：测量视口与真实内容宽度，并列出所有横向溢出的元素 */
function injectProbe(html) {
  const probe = `
<script>
(function () {
  function measure() {
    var de = document.documentElement;
    var out = {
      viewport: window.innerWidth,
      clientWidth: de.clientWidth,
      scrollWidth: de.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      overflow: [],
    };
    var all = document.querySelectorAll('body *');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.id === 'dca-measure') continue;
      var r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > de.clientWidth + 1 || r.left < -1)) {
        out.overflow.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          cls: (el.getAttribute('class') || '').slice(0, 70),
          left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width),
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
        });
      }
    }
    var pre = document.getElementById('dca-measure') || document.createElement('pre');
    pre.id = 'dca-measure';
    pre.textContent = 'DCA_MEASURE_START' + JSON.stringify(out) + 'DCA_MEASURE_END';
    if (!pre.parentNode) document.body.appendChild(pre);
  }
  if (document.readyState === 'complete') setTimeout(measure, 800);
  else window.addEventListener('load', function () { setTimeout(measure, 800); });
})();
</script>`;
  return html.replace('</body>', probe + '\n</body>');
}

/**
 * 注入表单约束校验探针。
 * 逐个给输入框塞入"用户真会填的值"，读 checkValidity()，
 * 把 (选择器, 值, 是否合法, 浏览器给的提示) 写进 DOM。
 *
 * ?validate=legacy 会先把 #amount 的属性还原成修复前的 min="1" step="100"，
 * 用来在同一个浏览器里对照证明根因（step 以 min 为基准点）。
 */
function injectValidator(html, legacy) {
  const probe = `
<script>
(function () {
  var LEGACY = ${legacy ? 'true' : 'false'};
  function run() {
    var CASES = {
      '#amount': [1, 2, 100, 500, 999, 1000, 1500, 2000, 2500, 2901, 2999, 3000, 3001, 3333, 5000, 8000, 10000, 12345, 20000, 100000],
      '#fee-rate': [0, 0.1, 2.5, 3, 10],
      '#fee-min': [0, 1, 5, 10, 20],
    };
    if (LEGACY) {
      var a = document.querySelector('#amount');
      a.setAttribute('min', '1');
      a.setAttribute('step', '100');
    }
    var out = { legacy: LEGACY, fields: [], invalid: [] };
    Object.keys(CASES).forEach(function (sel) {
      var el = document.querySelector(sel);
      if (!el) { out.invalid.push(sel + ' 不存在'); return; }
      var meta = {
        sel: sel, step: el.getAttribute('step'), min: el.getAttribute('min'), max: el.getAttribute('max'),
        bad: [],
      };
      var original = el.value;
      CASES[sel].forEach(function (v) {
        el.value = String(v);
        if (!el.checkValidity()) {
          meta.bad.push({ value: v, message: (el.validationMessage || '').slice(0, 70) });
          out.invalid.push(sel + ' = ' + v + ' 被判非法：' + (el.validationMessage || '').slice(0, 70));
        }
      });
      el.value = original;
      out.fields.push(meta);
    });
    var pre = document.getElementById('dca-validate') || document.createElement('pre');
    pre.id = 'dca-validate';
    pre.textContent = 'DCA_VALIDATE_START' + JSON.stringify(out) + 'DCA_VALIDATE_END';
    if (!pre.parentNode) document.body.appendChild(pre);
  }
  if (document.readyState === 'complete') setTimeout(run, 900);
  else window.addEventListener('load', function () { setTimeout(run, 900); });
})();
</script>`;
  return html.replace('</body>', probe + '\n</body>');
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`本地预览：http://127.0.0.1:${PORT}/  （根目录 docs/，Ctrl+C 退出）`);
  console.log(`布局量测：http://127.0.0.1:${PORT}/?measure=1  （配合 --dump-dom 使用）`);
});
