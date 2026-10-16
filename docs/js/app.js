/**
 * 主应用：表单 → 计算 → 图表 → 称号成就
 * 纯原生 JS，无构建步骤，无第三方依赖。
 */
import { simulateFromParams, monthIndex, monthLabel } from './compute.js';
import { decodeStockRecord } from './decode.js';
import { pickRank, evaluateAchievements, achievementGrade } from './achievements.js';
import { createChart, createYearBars, fmtAmount } from './chart.js';

// ── 常量 ────────────────────────────────────────────────────
const DB = window.__DCA_DB__;
const TODAY_MONTH = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
})();

const PRESETS = [
  { id: 'moutai', label: '🍶 茅台·十年信仰', code: '600519', start: '2016-01', end: TODAY_MONTH, amount: 3000, hint: '经典大蓝筹，最常被拿来做定投回测的标的' },
  { id: 'catl', label: '🔋 宁德时代·过山车', code: '300750', start: '2018-07', end: TODAY_MONTH, amount: 3000, hint: '新能源大牛股，估值从天上到地下' },
  { id: 'csi300', label: '🧺 沪深300·老实人', code: '510300', start: '2015-06', end: TODAY_MONTH, amount: 3000, hint: '从 2015 年牛市顶点开始定投宽基指数' },
  { id: 'oil', label: '🛢️ 中国石油·信仰崩塌', code: '601857', start: '2007-11', end: TODAY_MONTH, amount: 3000, hint: '上市即巅峰的著名案例' },
  { id: 'kweichow_bear', label: '🥬 隆基绿能·光伏腰斩', code: '601012', start: '2021-01', end: TODAY_MONTH, amount: 3000, hint: '从光伏龙头到价值毁灭' },
  { id: 'gold', label: '🥇 黄金ETF·避险', code: '518880', start: '2016-01', end: TODAY_MONTH, amount: 3000, hint: '不吃不喝不生产，但能穿越牛熊' },
];

const BENCHMARK_CODE = '510300'; // 沪深300ETF，作为"跑赢大盘"的对照

// ── 状态 ────────────────────────────────────────────────────
const state = {
  stocks: [],
  stock: null,
  benchmark: null,
  lastResult: null,
  chart: null,
  recent: [],
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ── 工具 ────────────────────────────────────────────────────
const clampMonth = (m, lo, hi) => (m < lo ? lo : m > hi ? hi : m);

function decodeStock(rec, scale) {
  const decodedSeries = decodeStockRecord(rec, scale);
  return {
    ...rec,
    decodedSeries,
    prices: decodedSeries.map((p) => p.close),
    firstMonth: rec.first,
    lastMonth: rec.last,
  };
}

const signClass = (v) => (v >= 0 ? 'up' : 'down');
const signed = (v, digits = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;
const pct = (v, digits = 2) => (Number.isFinite(v) ? `${signed(v * 100, digits)}%` : '—');
const money = (v) => `${v < 0 ? '-' : ''}${fmtAmount(Math.abs(v))}`;

// ── 初始化 ──────────────────────────────────────────────────
async function init() {
  if (!DB || !Array.isArray(DB.stocks)) {
    document.body.innerHTML = '<div class="fatal">行情数据库加载失败：请确认 data/stocks.js 存在。</div>';
    return;
  }
  const scale = DB.scale || 100;
  state.stocks = DB.stocks.map((s) => decodeStock(s, scale));
  state.benchmark = state.stocks.find((s) => s.code === BENCHMARK_CODE) || null;

  $('#data-meta').textContent =
    `内置 ${DB.stocks.length} 只标的 · 真实历史月度行情 · 数据截至 ${DB.stocks[0].last} · 复权口径：后复权（分红再投）`;

  buildPicker();
  buildPresets();
  buildMonthSelects();
  restoreFromHash();
  bindEvents();
  run({ silent: true });
}

// ── 标的检索与选择 ──────────────────────────────────────────
function matchStock(s, q) {
  if (!q) return false;
  const needle = q.toLowerCase();
  if (s.code.includes(needle)) return true;
  if (s.name.toLowerCase().includes(needle)) return true;
  return (s.alias || []).some((a) => a.toLowerCase().includes(needle));
}

function buildPicker() {
  const input = $('#stock-input');
  const list = $('#stock-list');

  const render = (q) => {
    const items = q
      ? state.stocks.filter((s) => matchStock(s, q)).slice(0, 60)
      : state.stocks.slice(0, 60);
    list.innerHTML = '';
    if (items.length === 0) {
      list.innerHTML = '<div class="picker-empty">没找到这个标的。当前版本内置了 64 只常见 A 股与 ETF，试试「茅台」「宁德」「300」「ETF」。</div>';
      return;
    }
    let lastGroup = '';
    for (const s of items) {
      if (s.group !== lastGroup) {
        lastGroup = s.group;
        const h = document.createElement('div');
        h.className = 'picker-group';
        h.textContent = s.group;
        list.appendChild(h);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'picker-item' + (state.stock && state.stock.code === s.code ? ' active' : '');
      btn.innerHTML =
        `<span class="pi-name">${s.name}</span>` +
        `<span class="pi-code">${s.code}</span>` +
        `<span class="pi-span">${s.firstMonth} 起</span>`;
      btn.title = s.tag || '';
      btn.addEventListener('click', () => {
        selectStock(s.code);
        closePicker();
      });
      list.appendChild(btn);
    }
  };

  input.addEventListener('input', () => render(input.value.trim()));
  input.addEventListener('focus', () => {
    openPicker();
    render(input.value.trim());
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePicker();
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = state.stocks.find((s) => matchStock(s, input.value.trim()));
      if (first) {
        selectStock(first.code);
        closePicker();
        run();
      }
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.stock-field')) closePicker();
  });
  render('');
}

function openPicker() {
  $('#stock-list').classList.add('open');
}
function closePicker() {
  $('#stock-list').classList.remove('open');
}

function selectStock(code) {
  const s = state.stocks.find((x) => x.code === code);
  if (!s) return;
  state.stock = s;
  $('#stock-input').value = `${s.name} ${s.code}`;
  $('#stock-tag').textContent = s.tag ? `💡 ${s.tag}` : '';
  $('#stock-span').textContent = `数据区间：${s.firstMonth} ~ ${s.lastMonth}（共 ${s.prices.length} 个月）`;
  clampMonthsToStock();
  saveRecent(s.code);
  $$('#stock-list .picker-item').forEach((b) => {
    b.classList.toggle('active', b.querySelector('.pi-code').textContent === code);
  });
}

function saveRecent(code) {
  state.recent = [code, ...state.recent.filter((c) => c !== code)].slice(0, 5);
  const box = $('#recent-box');
  box.innerHTML = '';
  for (const c of state.recent) {
    const s = state.stocks.find((x) => x.code === c);
    if (!s) continue;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = s.name;
    chip.addEventListener('click', () => {
      selectStock(c);
      run();
    });
    box.appendChild(chip);
  }
  box.classList.toggle('hidden', state.recent.length === 0);
}

// ── 月份选择器 ──────────────────────────────────────────────
function buildMonthSelects() {
  // 年份范围取"全库最早月份 ~ 全库最新月份"，而不是当前自然年：
  // 数据源是历史行情，用当前年做上限会凭空多出一堆没有数据的月份。
  const firstYears = state.stocks.map((s) => Number(s.firstMonth.slice(0, 4)));
  const lastYears = state.stocks.map((s) => Number(s.lastMonth.slice(0, 4)));
  const minYear = Math.min(...firstYears);
  const maxYear = Math.max(...lastYears, Number(TODAY_MONTH.slice(0, 4)));

  for (const prefix of ['start', 'end']) {
    const ySel = $(`#${prefix}-year`);
    const mSel = $(`#${prefix}-month`);
    ySel.innerHTML = '';
    for (let y = minYear; y <= maxYear; y++) {
      const o = document.createElement('option');
      o.value = String(y);
      o.textContent = `${y} 年`;
      ySel.appendChild(o);
    }
    mSel.innerHTML = '';
    for (let m = 1; m <= 12; m++) {
      const o = document.createElement('option');
      o.value = String(m).padStart(2, '0');
      o.textContent = `${m} 月`;
      mSel.appendChild(o);
    }
    // 先给出一个合法默认值，避免"读表单 → 写表单"的顺序问题产生 undefined
    const now = new Date();
    ySel.value = String(Math.min(Math.max(now.getFullYear(), minYear), maxYear));
    mSel.value = String(now.getMonth() + 1).padStart(2, '0');
  }
}

const getStartMonth = () => `${$('#start-year').value}-${$('#start-month').value}`;
const getEndMonth = () => `${$('#end-year').value}-${$('#end-month').value}`;

/**
 * 把任意来源的字符串解析成合法月份。
 * 分享链接里的参数是纯字符串比较，`#s=9999-99` 或 `#s=abc` 会让下拉框落到
 * 一个不存在的选项上（select.value 赋非法值时浏览器会把它清空），
 * 之后拼出来的月份就是 "-" 这种垃圾值。所以必须显式做数字与范围校验。
 */
function parseMonthParam(raw, lo, hi) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(raw || '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!(mo >= 1 && mo <= 12) || y < 1900 || y > 2200) return null;
  const ym = `${y}-${m[2]}`;
  return clampMonth(ym, lo, hi);
}

function setMonth(prefix, ym) {
  $(`#${prefix}-year`).value = ym.slice(0, 4);
  $(`#${prefix}-month`).value = ym.slice(5, 7);
}

function clampMonthsToStock() {
  const s = state.stock;
  if (!s) return;
  const store = readForm();
  const start = clampMonth(store.startMonth, s.firstMonth, s.lastMonth);
  const end = clampMonth(store.endMonth, s.firstMonth, s.lastMonth);
  setMonth('start', start);
  setMonth('end', end < start ? start : end);
  $('#range-note').textContent =
    `该标的可回测区间：${s.firstMonth} ~ ${s.lastMonth}`;
}

// ── 快捷预设 ────────────────────────────────────────────────
function buildPresets() {
  const box = $('#presets');
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip chip-preset';
    b.textContent = p.label;
    b.title = p.hint;
    b.addEventListener('click', () => applyPreset(p));
    box.appendChild(b);
  }
}

function applyPreset(p) {
  selectStock(p.code);
  const s = state.stock;
  setMonth('start', clampMonth(p.start, s.firstMonth, s.lastMonth));
  setMonth('end', clampMonth(p.end, s.firstMonth, s.lastMonth));
  $('#amount').value = String(p.amount);
  setAmountQuick(p.amount);
  run();
}

function setAmountQuick(v) {
  $$('#amount-quick .chip').forEach((c) => c.classList.toggle('active', Number(c.dataset.amount) === Number(v)));
}

// ── 表单读取 ────────────────────────────────────────────────
/** 金额上限：防止 URL 里的 1e308 之类把结果污染成 Infinity（渲染层会显示 "Infinity 亿"） */
const MAX_AMOUNT = 1e9;

function readForm() {
  const rawAmount = Number($('#amount').value);
  return {
    startMonth: getStartMonth(),
    endMonth: getEndMonth(),
    amount: Number.isFinite(rawAmount) ? Math.min(Math.max(1, Math.round(rawAmount)), MAX_AMOUNT) : 0,
    feeEnabled: $('#fee-toggle').checked,
    feeRate: Math.max(0, Number($('#fee-rate').value) || 0) / 10000,
    feeMin: Math.max(0, Number($('#fee-min').value) || 0),
  };
}

// ── 事件绑定 ────────────────────────────────────────────────
function bindEvents() {
  // 只绑定 form 的 submit：按钮是 type=submit，如果这里再绑一次 click，
  // 点一下会同时触发 click 与 submit，run() 跑两遍、图表重建两次。
  $('#form').addEventListener('submit', (e) => {
    e.preventDefault();
    run();
  });
  for (const id of ['#start-year', '#start-month', '#end-year', '#end-month', '#fee-rate', '#fee-min']) {
    $(id).addEventListener('change', () => run());
  }
  $('#fee-toggle').addEventListener('change', () => {
    $('#fee-fields').classList.toggle('hidden', !$('#fee-toggle').checked);
    run();
  });
  $('#amount').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      run();
    }
  });
  $('#amount').addEventListener('input', () => setAmountQuick(Number($('#amount').value)));

  const quick = $('#amount-quick');
  for (const v of [1000, 3000, 5000, 10000, 20000]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.amount = String(v);
    b.textContent = v >= 10000 ? `${v / 10000} 万` : `${v} 元`;
    b.addEventListener('click', () => {
      $('#amount').value = String(v);
      setAmountQuick(v);
      run();
    });
    quick.appendChild(b);
  }

  $('#share-btn').addEventListener('click', shareResult);
  $('#copy-summary').addEventListener('click', copySummary);
  window.addEventListener('hashchange', () => {
    restoreFromHash();
    run({ silent: true });
  });
}

// ── 计算并渲染 ──────────────────────────────────────────────
function run(opts = {}) {
  if (!state.stock) {
    selectStock(PRESETS[0].code);
  }
  // 兜底：万一数据库里连预设标的都没有（例如被人裁剪过），给一句人话而不是抛异常
  if (!state.stock) {
    $('#error-note').textContent = '没有可用的标的，请检查 data/stocks.js 是否完整。';
    return;
  }
  const form = readForm();
  const note = $('#error-note');

  if (form.amount <= 0) {
    note.textContent = '每月定投金额要大于 0。';
    return;
  }
  if (form.endMonth < form.startMonth) {
    note.textContent = '结束月份不能早于开始月份。';
    return;
  }
  note.textContent = '';

  let result;
  try {
    result = simulateFromParams(state.stock, form);
  } catch (err) {
    note.textContent = `算不出来：${err.message}`;
    return;
  }

  // 沪深300 同期基准
  let benchmarkAnnualized = NaN;
  if (state.benchmark && state.stock.code !== BENCHMARK_CODE) {
    try {
      const bmParams = {
        ...form,
        startMonth: clampMonth(form.startMonth, state.benchmark.firstMonth, state.benchmark.lastMonth),
        endMonth: clampMonth(form.endMonth, state.benchmark.firstMonth, state.benchmark.lastMonth),
      };
      if (bmParams.endMonth >= bmParams.startMonth) {
        const bm = simulateFromParams(state.benchmark, bmParams);
        benchmarkAnnualized = bm.summary.annualized;
      }
    } catch { /* 基准算不出来就忽略 */ }
  }

  const rank = pickRank(result.summary.annualized, result.summary.totalReturn, result.summary.years);

  // ── 成就上下文 ──
  const rangeStart = monthIndex(result.summary.startMonth);
  const rangeEnd = monthIndex(result.summary.endMonth);
  const ctx = {
    ...result,
    stockCode: state.stock.code,
    stockName: state.stock.name,
    stockFirstMonth: state.stock.firstMonth,
    stockLastMonth: state.stock.lastMonth,
    feeEnabled: form.feeEnabled,
    hasBenchmark: Number.isFinite(benchmarkAnnualized),
    benchmarkAnnualized,
    tradesTouched: (fromMi, toMi) => result.trades.some((t) => t.mi >= fromMi && t.mi <= toMi),
    startYearMonth: (ym) => monthIndex(ym),
    rangeStart,
    rangeEnd,
  };
  const ach = evaluateAchievements(ctx);

  state.lastResult = { result, rank, ach, ctx, form, benchmarkAnnualized };
  render(result, rank, ach, ctx, benchmarkAnnualized);
  writeHash(form, state.stock.code);
  if (!opts.silent) {
    $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function render(r, rank, ach, ctx, benchmarkAnnualized) {
  const s = r.summary;

  // 称号
  const badge = $('#rank-badge');
  badge.className = `rank-badge tone-${rank.tone}`;
  $('#rank-emoji').textContent = rank.emoji;
  $('#rank-title').textContent = rank.title;
  $('#rank-quote').textContent = rank.quote;
  $('#rank-desc').textContent = rank.desc;

  // 主数字
  const profitCls = signClass(s.profit);
  $('#hero-profit').textContent = `${s.profit >= 0 ? '+' : '−'}${fmtAmount(Math.abs(s.profit))}`;
  $('#hero-profit').className = `hero-value ${profitCls}`;
  $('#hero-return').textContent = pct(s.totalReturn);
  $('#hero-return').className = `hero-sub ${profitCls}`;
  $('#hero-annual').textContent = Number.isFinite(s.annualized) ? pct(s.annualized) : '—';
  $('#hero-annual').className = `hero-value ${signClass(s.annualized)}`;
  $('#hero-invested').textContent = money(s.totalInvested);
  $('#hero-value').textContent = money(s.finalValue);
  $('#hero-months').textContent = `${s.months} 期 / ${s.years.toFixed(1)} 年`;
  $('#hero-amount').textContent = `${money(s.monthlyAmount)} / 月`;

  // 一句话总结
  $('#verdict').innerHTML =
    `从 <b>${s.startMonth}</b> 到 <b>${s.endMonth}</b>，每月定投 <b>${money(s.monthlyAmount)}</b> 买入 <b>${ctx.stockName}（${ctx.stockCode}）</b>，` +
    `累计投入 <b>${money(s.totalInvested)}</b>，期末市值 <b>${money(s.finalValue)}</b>，` +
    `<span class="${signClass(s.profit)}">总盈亏 ${s.profit >= 0 ? '+' : '−'}${fmtAmount(Math.abs(s.profit))}（${pct(s.totalReturn)}），年化 ${pct(s.annualized)}</span>。`;

  // 详细指标
  const rows = [
    ['定投期数', `${s.months} 期（${s.calendarMonths} 个自然月，约 ${s.years.toFixed(2)} 年）`],
    ['每月定投', `${money(s.monthlyAmount)}${ctx.feeEnabled ? '（含手续费）' : ''}`],
    ['累计投入', money(s.totalInvested)],
    ['期末市值', money(s.finalValue)],
    ['总盈亏', `<span class="${signClass(s.profit)}">${s.profit >= 0 ? '+' : '−'}${fmtAmount(Math.abs(s.profit))}</span>`],
    ['总收益率', `<span class="${signClass(s.profit)}">${pct(s.totalReturn)}</span>`],
    ['年化收益率（IRR）', `<span class="${signClass(s.annualized)}">${pct(s.annualized)}</span>`],
    ['同期标的涨幅', `<span class="${signClass(s.marketReturn)}">${pct(s.marketReturn)}</span>　（买入首月 ${s.firstPrice.toFixed(2)} → 期末 ${s.endPrice.toFixed(2)}）`],
    ['一口气全投（一次性买入）', `把全部 <b>${money(s.lumpInvested)}</b> 在首月一次买入 → ${money(s.lumpValue)}，<span class="${signClass(s.lumpProfit)}">${pct(s.lumpReturn)}</span>（年化 ${pct(s.lumpAnnualized)}）<br><span class="muted">⚠️ 这只是"同样总资金一把梭"的数学参照：它要求你在第一个月就拿出 ${money(s.totalInvested)}，相当于 <b>${s.months}</b> 个月的月供，实际很少有人做得到；而按 ${money(s.monthlyAmount)} 分 ${s.months} 个月投入，正是定投降低择时风险的方式。</span>`],
    ['定投 vs 一把梭', `<span class="${signClass(s.totalReturn - s.lumpReturn)}">定投 ${s.totalReturn >= s.lumpReturn ? '跑赢' : '跑输'} ${Math.abs((s.totalReturn - s.lumpReturn) * 100).toFixed(1)} 个百分点</span>`],
    ...(Number.isFinite(benchmarkAnnualized)
      ? [['同期沪深300年化', `<span class="${signClass(s.annualized - benchmarkAnnualized)}">${pct(benchmarkAnnualized)}　→　本策略${s.annualized >= benchmarkAnnualized ? '跑赢' : '跑输'} ${Math.abs((s.annualized - benchmarkAnnualized) * 100).toFixed(2)} 个百分点</span>`]]
      : []),
    ['最大回撤', `<span class="down">-${(s.maxDrawdown * 100).toFixed(1)}%</span>${s.maxDrawdownAt ? `　（最深在 ${s.maxDrawdownAt}）` : ''}`],
    ['账面最惨时刻', s.worstMonth ? `${s.worstMonth}　浮亏 <span class="down">${pct(s.worstProfitRate)}</span>` : '—'],
    ['账面最爽时刻', s.bestMonth ? `${s.bestMonth}　浮盈 <span class="up">${pct(s.bestProfitRate)}</span>` : '—'],
    ['平均买入价', `${s.avgBuyPrice.toFixed(3)}　处于历史价格 ${(s.avgBuyPercentile * 100).toFixed(1)}% 分位`],
    ['期末价格分位', `${(s.endPercentile * 100).toFixed(1)}% 分位（0%=历史最低，100%=历史最高）`],
    ['期末持股', `${s.finalShares.toFixed(2)} 股（模拟净值份额）`],
  ];
  if (s.fees > 0) rows.push(['累计手续费', money(s.fees)]);
  if (s.idleCash >= 0.01) rows.push(['账户闲置零钱', money(s.idleCash)]);
  if (s.missedMonths > 0) rows.push(['行情缺失而暂停的月份', `${s.missedMonths} 个月（未扣款）`]);
  if (s.holdMonth && s.holdMonth !== s.endMonth) {
    rows.push([
      `若一直持有到 ${s.holdMonth}`,
      `市值 ${money(s.holdValue)}，<span class="${signClass(s.holdProfit)}">盈亏 ${pct(s.holdReturn)}</span>　（定投已停止，仅供对照）`,
    ]);
  }

  $('#detail-table').innerHTML = rows
    .map(([k, v]) => `<div class="dt-row"><div class="dt-k">${k}</div><div class="dt-v">${v}</div></div>`)
    .join('');

  // 图表
  if (state.chart) state.chart.destroy();
  state.chart = createChart($('#chart'), { curve: r.curve });
  createYearBars($('#year-bars'), r.yearly);

  // 成就
  const grade = achievementGrade(ach.score);
  $('#ach-grade').textContent = grade.label;
  $('#ach-grade-desc').textContent = grade.desc;
  $('#ach-score').textContent = `成就分 ${ach.score}`;
  $('#ach-count').textContent = `已解锁 ${ach.unlocked.length} / ${ach.unlocked.length + ach.locked.length}`;

  $('#ach-list').innerHTML = ach.unlocked.length
    ? ach.unlocked
        .map(
          (a) =>
            `<li class="ach-item r-${a.rarity}" title="${a.desc}"><span class="ach-emoji">${a.emoji}</span>` +
            `<span class="ach-body"><b>${a.name}</b><i>${a.desc}</i></span>` +
            `<span class="ach-rarity">${rarityLabel(a.rarity)}</span></li>`
        )
        .join('')
    : '<li class="ach-empty">这次没有解锁任何徽章，换个参数再试试——比如把定投时间拉长到 5 年以上。</li>';

  const nearest = ach.locked.slice(0, 6);
  $('#ach-locked').innerHTML = nearest.length
    ? nearest
        .map(
          (a) =>
            `<li class="ach-item locked" title="${a.desc}"><span class="ach-emoji">🔒</span>` +
            `<span class="ach-body"><b>${a.name}</b><i>${a.desc}</i></span></li>`
        )
        .join('')
    : '';

  $('#result').classList.remove('hidden');
  $('#placeholder').classList.add('hidden');
}

const rarityLabel = (r) =>
  ({ common: '普通', rare: '稀有', epic: '史诗', legend: '传说' }[r] || '普通');

// ── 分享 / 复制 ─────────────────────────────────────────────
function currentShareUrl() {
  const p = readForm();
  const params = new URLSearchParams({
    c: state.stock.code,
    s: p.startMonth,
    e: p.endMonth,
    a: String(p.amount),
    ...(p.feeEnabled ? { f: '1', fr: String(p.feeRate * 10000), fm: String(p.feeMin) } : {}),
  });
  return `${location.origin}${location.pathname}#${params.toString()}`;
}

async function shareResult() {
  const url = currentShareUrl();
  const s = state.lastResult ? state.lastResult.result.summary : null;
  const text = s ? `${state.stock.name} 定投 ${s.startMonth}→${s.endMonth}：投入 ${money(s.totalInvested)}，市值 ${money(s.finalValue)}，年化 ${pct(s.annualized)}` : '';
  const btn = $('#share-btn');
  const original = btn.textContent;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'A股定投模拟器', text, url });
    } else {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      btn.textContent = '✅ 链接已复制';
      setTimeout(() => (btn.textContent = original), 1800);
    }
  } catch {
    btn.textContent = '⚠️ 复制失败，请手动复制地址栏';
    setTimeout(() => (btn.textContent = original), 2500);
  }
  history.replaceState(null, '', url);
}

async function copySummary() {
  const snap = state.lastResult;
  if (!snap) return;
  const { result: r, rank } = snap;
  const s = r.summary;
  const lines = [
    `【A股定投模拟器】${snap.ctx.stockName}（${snap.ctx.stockCode}）`,
    `定投区间：${s.startMonth} ~ ${s.endMonth}（${s.months} 期）`,
    `每月定投：${money(s.monthlyAmount)}`,
    `累计投入：${money(s.totalInvested)}`,
    `期末市值：${money(s.finalValue)}`,
    `总盈亏：${s.profit >= 0 ? '+' : '−'}${fmtAmount(Math.abs(s.profit))}（${pct(s.totalReturn)}）`,
    `年化收益率：${pct(s.annualized)}`,
    `最大回撤：-${(s.maxDrawdown * 100).toFixed(1)}%`,
    `获得称号：${rank.emoji} ${rank.title}`,
    `解锁成就：${snap.ach.unlocked.map((a) => a.emoji + a.name).join('、') || '无'}`,
    '',
    '（娱乐为主，不构成投资建议）',
  ];
  const btn = $('#copy-summary');
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    btn.textContent = '✅ 已复制';
  } catch {
    btn.textContent = '⚠️ 复制失败';
  }
  setTimeout(() => (btn.textContent = original), 1800);
}

// ── URL 状态 ────────────────────────────────────────────────
function writeHash(form, code) {
  const params = new URLSearchParams({
    c: code,
    s: form.startMonth,
    e: form.endMonth,
    a: String(form.amount),
    ...(form.feeEnabled ? { f: '1', fr: String(form.feeRate * 10000), fm: String(form.feeMin) } : {}),
  });
  history.replaceState(null, '', `#${params.toString()}`);
}

function restoreFromHash() {
  const raw = location.hash.replace(/^#/, '');
  const params = new URLSearchParams(raw);
  const code = params.get('c');
  if (code && state.stocks.some((s) => s.code === code)) {
    selectStock(code);
  } else if (!state.stock) {
    selectStock(PRESETS[0].code);
  }
  const s = state.stock;
  if (!s) return;
  const startParam = parseMonthParam(params.get('s'), s.firstMonth, s.lastMonth);
  const endParam = parseMonthParam(params.get('e'), s.firstMonth, s.lastMonth);
  if (startParam) setMonth('start', startParam);
  if (endParam) setMonth('end', endParam);
  // 金额：只接受正数，避免 #a=-5 或 #a=abc 把输入框变成非法值
  const amountParam = Number(params.get('a'));
  if (Number.isFinite(amountParam) && amountParam > 0) {
    $('#amount').value = String(Math.min(amountParam, 1e9));
  }
  if (params.get('f') === '1') {
    $('#fee-toggle').checked = true;
    $('#fee-fields').classList.remove('hidden');
    const fr = Number(params.get('fr'));
    if (Number.isFinite(fr) && fr >= 0) $('#fee-rate').value = String(Math.min(fr, 100));
    const fm = Number(params.get('fm'));
    if (Number.isFinite(fm) && fm >= 0) $('#fee-min').value = String(Math.min(fm, 1000));
  }
  if (!startParam) {
    // 默认：最近 10 年（或该标的的全部历史）
    const end = clampMonth(TODAY_MONTH, s.firstMonth, s.lastMonth);
    const startMi = Math.max(monthIndex(s.firstMonth), monthIndex(end) - 119);
    setMonth('end', end);
    setMonth('start', monthLabel(startMi));
  }
  // 起止顺序兜底：分享链接可能把两个参数写反
  if (getEndMonth() < getStartMonth()) {
    setMonth('end', getStartMonth());
  }
  setAmountQuick(Number($('#amount').value));
}

init().catch((err) => {
  console.error(err);
  const note = document.querySelector('#error-note');
  if (note) note.textContent = `初始化失败：${err.message}`;
});
