/**
 * 无头启动测试：用轻量 DOM 垫片真的把 docs/index.html + 全部前端脚本跑起来，
 * 验证"首屏能渲染、点击预设能算、结果数字自洽、图表有产出、称号能颁发"。
 *
 * 目的：页面逻辑几乎全在浏览器里，Node 单测覆盖不到；
 * 而这里不引入 jsdom/puppeteer 这种重依赖，靠一个几十行的 DOM 垫片把
 * app.js 真正执行一遍，能抓出"选择器写错、渲染函数抛错、字段名拼错"这类问题。
 *
 * 用法：node tools/headless.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');

const problems = [];
const logs = [];
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    problems.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
};

// ── 极简 DOM 垫片 ─────────────────────────────────────────────
class ClassList {
  constructor(el) { this.el = el; }
  get set() { return new Set((this.el.className || '').split(/\s+/).filter(Boolean)); }
  _write(s) { this.el.className = [...s].join(' '); }
  add(...cs) { const s = this.set; cs.forEach((c) => s.add(c)); this._write(s); }
  remove(...cs) { const s = this.set; cs.forEach((c) => s.delete(c)); this._write(s); }
  toggle(c, force) {
    const s = this.set;
    const on = force === undefined ? !s.has(c) : !!force;
    if (on) s.add(c); else s.delete(c);
    this._write(s);
    return on;
  }
  contains(c) { return this.set.has(c); }
}

let elementSeq = 0;
class El {
  constructor(tag, attrs = {}) {
    this.tagName = String(tag).toUpperCase();
    this.attributes = { ...attrs };
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this._text = '';
    this._html = '';
    this.value = attrs.value !== undefined ? String(attrs.value) : '';
    this.className = attrs.class || '';
    this.id = attrs.id || '';
    this.checked = false;
    this.listeners = {};
    this._uid = ++elementSeq;
    this.classList = new ClassList(this);
    // data-* 属性必须解析进 dataset：真实 DOM 里 `el.dataset.mode` 读的就是它，
    // 漏掉会让"按钮读不到自己的 data-mode"这类 bug 被测试掩盖。
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('data-')) {
        const key = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        this.dataset[key] = String(v);
      }
    }
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    // 真实 DOM 里 innerHTML 赋值会重建子节点。垫片必须做同样的轻量解析，
    // 否则页面里 `el.innerHTML = '<span class="x">…</span>'` 之后再
    // `el.querySelector('.x')` 会拿到 null，把这类正常写法误判成 bug。
    this.children = parseFragment(this._html, this);
  }
  get offsetWidth() { return 100; }
  get offsetHeight() { return 40; }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'class') this.className = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  removeAttribute(k) { delete this.attributes[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  prepend(c) { c.parentNode = this; this.children.unshift(c); return c; }
  remove() {
    if (this.parentNode) {
      const i = this.parentNode.children.indexOf(this);
      if (i >= 0) this.parentNode.children.splice(i, 1);
      // 真实 DOM 里移除后节点不再有父级；不清空会让垫片出现"孤儿仍能被找到"的假象
      this.parentNode = null;
    }
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    const l = this.listeners[type] || [];
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  dispatch(type, ev = {}) {
    const e = { type, target: this, preventDefault() {}, stopPropagation() {}, ...ev };
    for (const fn of this.listeners[type] || []) fn(e);
    return e;
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 320, right: 800, bottom: 320 }; }
  scrollIntoView() {}
  closest(sel) {
    let n = this;
    while (n) {
      if (matches(n, sel)) return n;
      n = n.parentNode;
    }
    return null;
  }
  querySelector(sel) { return this._find(sel, true); }
  querySelectorAll(sel) { return this._find(sel, false); }
  _find(sel, first) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (matches(c, sel)) {
          out.push(c);
          if (first) return true;
        }
        if (walk(c)) return true;
      }
      return false;
    };
    walk(this);
    return first ? out[0] || null : out;
  }
  get firstChild() { return this.children[0] || null; }
}

function matches(el, sel) {
  if (!el || !sel) return false;
  const s = sel.trim();

  // 后代选择器（如 '#end-mode .seg' / '.panel .btn'）：逐段校验祖先链
  if (s.includes(' ')) {
    const parts = s.split(/\s+/).filter(Boolean);
    if (!matches(el, parts[parts.length - 1])) return false;
    let node = el.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
      let found = false;
      while (node) {
        if (matches(node, parts[i])) { found = true; node = node.parentNode; break; }
        node = node.parentNode;
      }
      if (!found) return false;
    }
    return true;
  }

  if (s.startsWith('#')) return el.id === s.slice(1);
  if (s.startsWith('.')) return (el.className || '').split(/\s+/).includes(s.slice(1));
  if (s.includes('[')) {
    // 属性选择器：[data-mode]
    const m = /^([a-zA-Z][\w-]*)?\[([\w-]+)(?:=(["']?)([^"'\]]*)\3)?\]$/.exec(s);
    if (!m) return false;
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    const attr = m[2];
    const want = m[4];
    const has = el.attributes ? el.attributes[attr] !== undefined : false;
    return want === undefined ? has : String(el.attributes[attr]) === want;
  }
  return el.tagName === s.toUpperCase();
}

function parseHTML(html) {
  // 只解析标签与 id/class 属性，够用了：我们要验证的是"选择器能不能找到元素"
  const root = new El('#document');
  const stack = [root];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>/g;
  let m;
  const VOID = new Set(['br', 'img', 'input', 'meta', 'link', 'hr', 'source', 'path', 'circle', 'line', 'text', 'stop', 'use']);
  while ((m = re.exec(html))) {
    const [, close, tag, rawAttrs, selfClose] = m;
    const t = tag.toLowerCase();
    if (t === 'script' || t === 'style') continue;
    if (close) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs = {};
    for (const a of rawAttrs.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = a[2];
    const el = new El(t, attrs);
    stack[stack.length - 1].appendChild(el);
    if (!selfClose && !VOID.has(t)) stack.push(el);
  }
  return root;
}

/** 与 parseHTML 共用同一套规则，但把结果挂到 parent 下（用于 innerHTML 赋值） */
function parseFragment(html, parent) {
  const frag = parseHTML(html);
  for (const child of frag.children) child.parentNode = parent;
  return frag.children;
}

// ── 组装 window / document ────────────────────────────────────
const html = await fs.readFile(path.join(DOCS, 'index.html'), 'utf8');
const domRoot = parseHTML(html);

const storage = new Map();
const documentStub = {
  documentElement: new El('html'),
  body: domRoot._find('body', true) || new El('body'),
  createElement: (tag) => new El(tag),
  createElementNS: (_ns, tag) => new El(tag),
  createTextNode: (t) => { const e = new El('#text'); e.textContent = t; return e; },
  createDocumentFragment: () => new El('#fragment'),
  querySelector: (sel) => domRoot._find(sel, true),
  querySelectorAll: (sel) => domRoot._find(sel, false),
  getElementById: (id) => domRoot._find('#' + id, true),
  addEventListener() {},
  removeEventListener() {},
  hidden: false,
};

const locationStub = {
  href: 'http://127.0.0.1:4173/',
  origin: 'http://127.0.0.1:4173',
  pathname: '/',
  hash: '',
};

const win = {
  document: documentStub,
  location: locationStub,
  navigator: { userAgent: 'node-headless', clipboard: { writeText: async () => {} } },
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
  console,
  history: { replaceState() {}, pushState() {} },
  requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  Date,
  Intl,
  URLSearchParams,
  // window 级事件：app.js 会监听 hashchange，需要能手动触发
  _listeners: {},
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
  removeEventListener(type, fn) {
    const l = this._listeners[type] || [];
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  },
  dispatchEvent(type, ev = {}) {
    for (const fn of this._listeners[type] || []) fn({ type, target: this, preventDefault() {}, ...ev });
    return true;
  },
};

win.window = win;
win.globalThis = win;
win.self = win;

const context = vm.createContext(win);
// 顶层 await 需要 module 语义，这里改用先把模块源码注入 context 执行的方式
const runModule = async (relPath) => {
  const src = await fs.readFile(path.join(DOCS, relPath), 'utf8');
  const rewritten = src
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')           // 去掉 import（依赖已手动注入）
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')          // 去掉聚合导出
    .replace(/^export\s+(function|const|let|class)/gm, '$1');
  const wrapped = `(function(){ ${rewritten}\n; return { ${collectExports(src).join(', ')} }; })()`;
  return vm.runInContext(wrapped, context, { filename: relPath });
};
function collectExports(src) {
  const names = new Set();
  for (const m of src.matchAll(/^export\s+function\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+const\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+class\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  // export { a, b as c } 形式的聚合导出
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  return [...names];
}

// 先注入数据与依赖模块
vm.runInContext(await fs.readFile(path.join(DOCS, 'data', 'stocks.js'), 'utf8'), context, { filename: 'stocks.js' });

// 依赖顺序：decode → compute → achievements → chart → app
const decode = await runModule('js/decode.js');
const compute = await runModule('js/compute.js');
const achievements = await runModule('js/achievements.js');
const chart = await runModule('js/chart.js');
Object.assign(win, decode, compute, achievements, chart);
// app.js 依赖同名函数，直接挂在 window 上供其自由引用
vm.runInContext(
  `var decodeStockRecord = window.decodeStockRecord, simulateFromParams = window.simulateFromParams,
        monthIndex = window.monthIndex, monthLabel = window.monthLabel,
        pickRank = window.pickRank, evaluateAchievements = window.evaluateAchievements,
        achievementGrade = window.achievementGrade,
        createChart = window.createChart, createYearBars = window.createYearBars, fmtAmount = window.fmtAmount;`,
  context
);

// ── 跑 app.js ─────────────────────────────────────────────────
const appSrc = await fs.readFile(path.join(DOCS, 'js', 'app.js'), 'utf8');
const appCode = appSrc
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
  .replace(/^export\s+/gm, '');

console.log('=== 无头启动测试 ===');
const errors = [];
win.console = {
  ...console,
  error: (...a) => {
    const first = a[0];
    if (first && first.stack) errors.push(first.stack);
    else errors.push(a.map(String).join(' '));
  },
  warn: () => {},
};
try {
  vm.runInContext(appCode, context, { filename: 'app.js' });
  // app.js 结尾调用 init()，内部是 async；等一轮微任务 + 定时器
  await new Promise((r) => setTimeout(r, 400));
} catch (err) {
  check('app.js 执行不抛错', false, err.message + '\n' + (err.stack || '').split('\n').slice(1, 4).join('\n'));
}

check('初始化过程没有 console.error', errors.length === 0, errors.join(' | '));

const $ = (sel) => domRoot._find(sel, true);
const $$ = (sel) => domRoot._find(sel, false);
// 垫片的 _find 支持后代选择器（如 '#end-mode .seg'），但必须直接从文档根查，
// 不能从某个元素出发 —— 从元素出发会漏掉"自己不在子树里但选择器要求祖先"的情况。
// 之前垫片只会做简单选择器匹配，导致 '#end-mode .seg' 匹配不到任何按钮，
// 于是这些按钮从未绑上事件，把这个坑错当成产品 bug 查了很久。
const $id = (id) => domRoot._find('#' + id, true);
check('错误提示区为空', !$id('error-note') || !$id('error-note').textContent, $id('error-note') && $id('error-note').textContent);
check('标的输入框已回填', !!($id('stock-input') && $id('stock-input').value), $id('stock-input') && $id('stock-input').value);
check('结果区已显示（去掉 hidden）', !!($id('result') && !$id('result').classList.contains('hidden')));
check('称号已颁发', !!($id('rank-title') && $id('rank-title').textContent && $id('rank-title').textContent !== '韭菜中的韭菜'),
  $id('rank-title') && $id('rank-title').textContent);
check('总盈亏有数字', !!($id('hero-profit') && /\d/.test($id('hero-profit').textContent)), $id('hero-profit') && $id('hero-profit').textContent);
check('年化收益率有数字', !!($id('hero-annual') && /%/.test($id('hero-annual').textContent)), $id('hero-annual') && $id('hero-annual').textContent);
check('一句话总结已渲染', !!($id('verdict') && $id('verdict').innerHTML.length > 40));
check('明细表已渲染', !!($id('detail-table') && $id('detail-table').innerHTML.length > 200));
check('成就列表已渲染', !!($id('ach-list') && $id('ach-list').innerHTML.length > 20));
check('图表容器已插入 SVG', !!($id('chart') && $id('chart').children.length > 0));
check('年度柱状渲染', !!($id('year-bars') && $id('year-bars').children.length > 0));
check('数据来源提示已写出', !!($id('data-meta') && $id('data-meta').textContent.includes('真实历史月度行情')),
  $id('data-meta') && $id('data-meta').textContent);
check('预设按钮已生成', !!($id('presets') && $id('presets').children.length >= 5), `${$id('presets') && $id('presets').children.length} 个`);

// 金额输入框的浏览器原生约束：step 必须以 min 为基准点来算合法值。
// 曾经写成 min="1" step="100"，合法值只有 1 + n×100（1、101 …… 2901、3001），
// 于是 3000 / 5000 / 10000 全被判非法，浏览器直接弹「请输入有效值」。
{
  const amt = $id('amount');
  const step = amt.getAttribute('step');
  const min = Number(amt.getAttribute('min'));
  const legal = (v) => Number.isInteger((v - min) / Number(step));
  const typical = [1, 2, 100, 500, 999, 1000, 1500, 2500, 2901, 2999, 3000, 3001, 3333, 5000, 10000, 12345, 20000];
  const rejected = typical.filter((v) => !legal(v));
  check('金额框对常见整数都合法（step 不能配错 min）', rejected.length === 0,
    `step=${step} min=${min}，被拒：${rejected.join(', ')}`);
  check('金额框设置了上限（防止 1e308 变成 Infinity）', Number(amt.getAttribute('max')) > 0,
    `max=${amt.getAttribute('max')}`);
}

// 点击每个预设按钮，验证都能算出结果且数字自洽
const presets = ($id('presets') && $id('presets').children) || [];
let presetOk = 0;
for (const btn of presets) {
  const label = btn.textContent;
  try {
    btn.dispatch('click');
    await new Promise((r) => setTimeout(r, 30));
    const profitText = $id('hero-profit').textContent;
    const annual = $id('hero-annual').textContent;
    const title = $id('rank-title').textContent;
    const note = $id('error-note').textContent;
    if (!note && /[+\-−]/.test(profitText) && /%/.test(annual) && title) presetOk++;
    else console.log(`     预设失败：${label} 盈亏=${profitText} 年化=${annual} 称号=${title} 错误=${note}`);
  } catch (err) {
    console.log(`     预设抛错：${label} ${err.message}`);
  }
}
check(`全部 ${presets.length} 个预设剧本都能算出结果`, presetOk === presets.length, `成功 ${presetOk}/${presets.length}`);

// 工具：模拟用户点击"计算"按钮。按钮是 type=submit，真实浏览器会触发表单提交，
// 所以这里也走 submit 路径（app.js 只在 form 上绑了 submit，避免重复计算）。
const form = $id('form');
const clickCalc = () => form.dispatch('submit');

// 切换标的（含别名搜索）与极端参数
const input = $id('stock-input');
const list = $id('stock-list');
// 注意：垫片不解析 innerHTML 字符串，所以这里检查 innerHTML 而不是 textContent
const listHTML = () => (list ? list.innerHTML : '');
const listIds = () => (list ? list.children.map((c) => c.innerHTML + c.textContent).join(' / ') : '');

input.value = '宁德';
input.dispatch('input');
check('别名搜索能命中宁德时代', listIds().includes('300750') || listHTML().includes('300750'), listIds().slice(0, 120));

input.value = '茅台';
input.dispatch('input');
check('中文名搜索能命中贵州茅台', listIds().includes('600519'), listIds().slice(0, 120));

input.value = 'ETF';
input.dispatch('input');
check('关键词搜索能命中 ETF 列表', listIds().includes('510300') && listIds().includes('588000'), listIds().slice(0, 160));

input.value = '不存在的标的xyz';
input.dispatch('input');
check('搜不到时给出提示而不是空白', listHTML().includes('没找到'), listHTML().slice(0, 60));

// 极端参数：金额很小、区间 2 个月
input.value = '600519';
input.dispatch('input');
$id('start-year').value = '2026'; $id('start-month').value = '09';
$id('end-year').value = '2026'; $id('end-month').value = '10';
$id('amount').value = '1';
clickCalc();
await new Promise((r) => setTimeout(r, 30));
check('极端小额 + 2 个月区间也能出结果或给出友好提示',
  !$id('error-note').textContent || $id('error-note').textContent.includes('算不出来') || $id('error-note').textContent.includes('区间'),
  $id('error-note').textContent);

// 单期（起 = 止）：年化不能退化成 "—"
$id('amount').value = '3000';
$id('start-year').value = '2020'; $id('start-month').value = '01';
$id('end-year').value = '2020'; $id('end-month').value = '01';
clickCalc();
await new Promise((r) => setTimeout(r, 30));
check('起止同月（只有 1 笔成交）也能给出年化而不是 "—"',
  $id('hero-annual').textContent.includes('%'), `年化=${$id('hero-annual').textContent}`);

// 超范围金额：不能把结果污染成 Infinity
$id('start-year').value = '2016'; $id('start-month').value = '01';
$id('end-year').value = '2026'; $id('end-month').value = '10';
$id('amount').value = '1e308';
clickCalc();
await new Promise((r) => setTimeout(r, 30));
const hugeProfit = $id('hero-profit').textContent;
check('超大金额被夹到上限，不出现 Infinity/NaN',
  !/Infinity|NaN/.test(hugeProfit) && !/Infinity|NaN/.test($id('hero-value').textContent),
  `盈亏=${hugeProfit} 市值=${$id('hero-value').textContent}`);

// 手续费开关
$id('amount').value = '3000';
$id('start-year').value = '2018'; $id('start-month').value = '01';
$id('end-year').value = '2026'; $id('end-month').value = '10';
clickCalc();
await new Promise((r) => setTimeout(r, 30));
const beforeFee = $id('hero-value').textContent;
$id('fee-toggle').checked = true;
$id('fee-toggle').dispatch('change');
await new Promise((r) => setTimeout(r, 30));
const afterFee = $id('hero-value').textContent;
check('开启手续费后页面重算且不报错', !$id('error-note').textContent, $id('error-note').textContent);
check('手续费开关产生可观察变化', beforeFee !== afterFee, `${beforeFee} -> ${afterFee}`);

// 截止月语义（卖出离场 / 继续持有）：两种口径必须都能选，且结果确实不同
{
  const segs = $id('end-mode').children;
  check('截止口径有两个可选按钮', segs.length === 2, `${segs.length} 个`);
  const segLiq = segs.find((b) => b.dataset.mode === 'liquidate');
  const segHold = segs.find((b) => b.dataset.mode === 'hold');
  check('两个按钮的 data-mode 正确', !!segLiq && !!segHold);

  // 区间固定在 2016-01 ~ 2020-01（截止月早于数据最新月，两种口径才会有差别）
  input.value = '600519';
  input.dispatch('input');
  $id('amount').value = '3000';
  $id('start-year').value = '2016'; $id('start-month').value = '01';
  $id('end-year').value = '2020'; $id('end-month').value = '01';
  clickCalc(); // 真实浏览器里下拉框会触发 change 事件，垫片不会，所以显式重算
  await new Promise((r) => setTimeout(r, 30));

  segLiq.dispatch('click');
  await new Promise((r) => setTimeout(r, 30));
  const liqValue = $id('hero-value').textContent;
  const liqAnnual = $id('hero-annual').textContent;
  const liqBanner = $id('mode-banner').innerHTML;
  check('选中「截止月全部卖出」后有醒目口径提示', liqBanner.includes('全部卖出') && liqBanner.includes('2020-01'),
    liqBanner.slice(0, 60));
  check('卖出口径下按钮为选中态', segLiq.classList.contains('active') && segLiq.getAttribute('aria-checked') === 'true');

  segHold.dispatch('click');
  await new Promise((r) => setTimeout(r, 30));
  const holdValue = $id('hero-value').textContent;
  const holdAnnual = $id('hero-annual').textContent;
  const holdBanner = $id('mode-banner').innerHTML;
  check('选中「停止定投后继续持有」后有醒目口径提示', holdBanner.includes('继续持有'), holdBanner.slice(0, 60));
  check('持有口径下按钮为选中态', segHold.classList.contains('active') && segHold.getAttribute('aria-checked') === 'true');

  check('两种口径的期末市值不同', liqValue !== holdValue, `卖出 ${liqValue} vs 持有 ${holdValue}`);
  check('两种口径的年化不同', liqAnnual !== holdAnnual, `卖出 ${liqAnnual} vs 持有 ${holdAnnual}`);
  check('切换口径后没有报错', !$id('error-note').textContent, $id('error-note').textContent);

  // 明细表要写明用的是哪种口径，并给出另一种口径的对照
  const detail = $id('detail-table').innerHTML;
  check('明细表写出了结算口径', detail.includes('结算口径') && detail.includes('继续持有'));
  check('明细表给出了另一种口径的对照值', detail.includes('若改成'));
  check('明细表区分了扣款截止月与结算月', detail.includes('扣款截止月'));

  // 截止月 = 数据最新月时，应提示两种口径等价，且结果一致
  $id('end-year').value = '2026'; $id('end-month').value = '10';
  segLiq.dispatch('click');
  await new Promise((r) => setTimeout(r, 30));
  const lastLiq = $id('hero-value').textContent;
  const lastLiqAnnual = $id('hero-annual').textContent;
  segHold.dispatch('click');
  await new Promise((r) => setTimeout(r, 30));
  check('截止月=最新月时两种口径结果相同',
    $id('hero-value').textContent === lastLiq && $id('hero-annual').textContent === lastLiqAnnual,
    `卖出 ${lastLiq}/${lastLiqAnnual} vs 持有 ${$id('hero-value').textContent}/${$id('hero-annual').textContent}`);
  check('截止月=最新月时提示两种口径等价',
    $id('end-mode-note').textContent.includes('相同'), $id('end-mode-note').textContent);

  // 恢复回默认口径，避免影响后续断言
  segLiq.dispatch('click');
  await new Promise((r) => setTimeout(r, 30));
}

// 恶意/损坏的分享链接：不能让页面进入非法状态
const hashCases = [
  '#c=600519&s=9999-99&e=0000-00&a=-5',
  '#c=600519&s=abc&e=def&a=NaN',
  '#c=999999&s=2020-01&e=2021-01',
  '#c=600519&s=2025-01&e=2015-01&a=3000',
  '#c=600519&f=1&fr=-3&fm=abc',
  '#c=600519&m=%E4%B9%B1%E5%86%99&s=2016-01&e=2026-10',
  '#%E4%B8%8D%E5%AD%98%E5%9C%A8',
];
let hashOk = 0;
for (const h of hashCases) {
  locationStub.hash = h;
  try {
    win.dispatchEvent('hashchange');
    await new Promise((r) => setTimeout(r, 30));
    const note = $id('error-note').textContent;
    const startY = $id('start-year').value;
    const startM = $id('start-month').value;
    const endY = $id('end-year').value;
    const endM = $id('end-month').value;
    const amount = Number($id('amount').value);
    const monthsValid = /^\d{4}$/.test(startY) && /^\d{2}$/.test(startM) && /^\d{4}$/.test(endY) && /^\d{2}$/.test(endM);
    const orderOk = `${endY}-${endM}` >= `${startY}-${startM}`;
    if (!note && monthsValid && orderOk && amount > 0) hashOk++;
    else console.log(`     链接失败 ${h} -> 错误="${note}" 月份=${startY}-${startM}~${endY}-${endM} 金额=${amount}`);
  } catch (err) {
    console.log(`     链接抛错 ${h}: ${err.message}`);
  }
}
check(`恶意/损坏分享链接 ${hashCases.length} 例均被安全兜底`, hashOk === hashCases.length, `成功 ${hashOk}/${hashCases.length}`);
locationStub.hash = '';

console.log(`\n无头启动测试：${problems.length === 0 ? '全部通过' : problems.length + ' 项失败'}`);
if (problems.length) {
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
