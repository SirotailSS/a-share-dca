#!/usr/bin/env node
/**
 * 自检脚本（零测试框架依赖）：node tools/selftest.mjs
 *
 * 覆盖四个层次：
 *   1) 压缩编解码无损（价格序列 / 月序号序列 / 负数 / 大数 / 边界值）；
 *   2) 内置数据库的元信息与序列自洽，且浏览器端解码器能正确展开；
 *   3) 计算引擎的正确性：IRR 闭式解、手工推导的定投路径、手续费、区间裁剪；
 *   4) 覆盖率与合理性护栏（标的数量、历史长度、全库压力测试），
 *      防止上游接口变动后悄悄退化成小样本或算出离谱数字。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { encodeSeries, decodeSeries, encodeMonths, encodeInts, decodeInts } from './build-db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
  } else {
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  x ${name}${detail ? ' — ' + detail : ''}`);
  }
}
function near(a, b, eps, name) {
  const ok = Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;
  check(name, ok, `期望 ${b}，实际 ${a}，容差 ${eps}`);
}

// 测试内联的月份还原（独立实现一遍，防止"用同一段错代码自证"）
function monthsFromCode(str, offset, count) {
  const idx = decodeInts(str, offset);
  if (idx.length !== count) throw new Error(`月份数量不一致：${idx.length} != ${count}`);
  return idx.map((mi) => `${Math.floor(mi / 12)}-${String((mi % 12) + 1).padStart(2, '0')}`);
}

// ── 1. 压缩编解码 ──────────────────────────────────────────
{
  const priceCases = [
    [1, 2, 3],
    [37.01, 37.09, 35.05, 8283.59],
    [0.01, 0.02, 0.01],
    [1.03, 1.03, 1.03],
    [12000.55, 3.02, 99999.99],
    Array.from({ length: 400 }, (_, i) => 10 + Math.sin(i / 7) * 5 + i * 0.13),
  ];
  for (const [i, c] of priceCases.entries()) {
    const code = encodeSeries(c);
    const round = decodeSeries(code.str, code.offset);
    // 编码精度是「分」，所以比较基准是各点四舍五入到分之后的值
    const expected = c.map((v) => Math.round(v * 100) / 100);
    check(
      `价格序列编解码无损 #${i + 1}`,
      round.length === c.length && round.every((v, k) => Math.abs(v - expected[k]) < 1e-9),
      `${c.slice(0, 3)}… -> ${round.slice(0, 3)}…（offset=${code.offset}）`
    );
  }

  const intCases = [
    [0, 1, 127, 128, 9999, 0, 3],
    [0, -7, 6, -21, 12],
    [-49, 3, -1000, 0, 262143],
    [0],
    [5],
    [-1, -2, -3],
    [63, 64, 65, 4095, 4096, 262143, 262144, 16777215],
    Array.from({ length: 300 }, (_, i) => (i % 2 ? -i * 7 : i * 3)),
  ];
  for (const [i, c] of intCases.entries()) {
    const code = encodeInts(c);
    const back = decodeInts(code.str, code.offset);
    check(
      `整数序列编解码 #${i + 1}`,
      JSON.stringify(back) === JSON.stringify(c),
      `${c.slice(0, 6)}… -> ${back.slice(0, 6)}…（offset=${code.offset}）`
    );
  }
  check('空序列编解码', decodeInts(encodeInts([]).str, 0).length === 0);
  check('非整数会被拒绝', (() => {
    try { encodeInts([1.5]); return false; } catch { return true; }
  })());

  // 月份序列：缺月 / 等距 / 连续 / 跨 36 年 四种情况
  const monthCases = [
    ['2001-08', '2001-09', '2002-03', '2002-04', '2003-01'],
    ['2019-01', '2019-03', '2019-05', '2019-07'],
    ['2020-01', '2020-02', '2020-03', '2020-04'],
    ['1991-01', '2026-10'],
    ['2007-11', '2008-06', '2015-04', '2024-09'],
  ];
  for (const [i, ms] of monthCases.entries()) {
    const code = encodeMonths(ms);
    const back = monthsFromCode(code.str, code.offset, ms.length);
    check(`月份序列编解码 #${i + 1}`, back.join(',') === ms.join(','), `${ms.slice(0, 3)}… -> ${back.slice(0, 3)}…`);
  }
  check('月份数量不匹配会抛错', (() => {
    try {
      const code = encodeMonths(['2020-01', '2020-02']);
      monthsFromCode(code.str, code.offset, 3);
      return false;
    } catch { return true; }
  })());

  const big = Array.from({ length: 5000 }, (_, i) => 1 + Math.round(((i * i) / 977) * 100) / 100);
  const t0 = Date.now();
  const encBig = encodeSeries(big);
  const decBig = decodeSeries(encBig.str, encBig.offset);
  check('长序列编解码无损', decBig.every((v, k) => Math.abs(v - big[k]) < 1e-9));
  check('长序列压缩比 > 1.5x', encBig.str.length < JSON.stringify(big).length / 1.5,
    `编码 ${encBig.str.length} 字符 vs 原文 ${JSON.stringify(big).length} 字符`);
  console.log(`     (5000 点编解码 ${Date.now() - t0}ms，编码后 ${encBig.str.length} 字符，压缩比 ${(JSON.stringify(big).length / encBig.str.length).toFixed(2)}x)`);
}

// ── 2. 数据库 + 浏览器解码器 ────────────────────────────────
const dbCode = await fs.readFile(path.join(DOCS, 'data', 'stocks.js'), 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(dbCode, sandbox);
const DB = sandbox.window.__DCA_DB__;
check('数据库存在', !!DB && Array.isArray(DB.stocks));
check('数据库 schema 版本 = 3', DB.schema === 3, `实际 ${DB.schema}`);
check('标的数量 >= 60', DB.stocks.length >= 60, `实际 ${DB.stocks.length}`);

const decodeMod = await import(pathToFileURL(path.join(DOCS, 'js', 'decode.js')).href);
const { decodeStockRecord } = decodeMod;

let seriesFail = 0;
let gapsFound = 0;
const spans = [];
for (const s of DB.stocks) {
  let series;
  try {
    series = decodeStockRecord(s, DB.scale);
  } catch (err) {
    seriesFail++;
    console.log(`  x ${s.name}(${s.code}) 解码失败：${err.message}`);
    continue;
  }
  spans.push(series.length);
  const monthIdx = series.map((p) => {
    const [y, m] = p.month.split('-').map(Number);
    return y * 12 + m - 1;
  });
  const dense = monthIdx.every((mi, i) => i === 0 || mi === monthIdx[i - 1] + 1);
  if (!dense) gapsFound++;
  const metaOk =
    series.length > 5 &&
    series.length === s.span &&
    series.every((p) => p.close > 0) &&
    series[0].month === s.first &&
    series[series.length - 1].month === s.last &&
    // 价格编码精度是「分」，所以这里按半分容差比较
    Math.abs(series[0].close - s.firstClose) < 0.0051 &&
    Math.abs(series[series.length - 1].close - s.lastClose) < 0.0051 &&
    series.every((p, i) => i === 0 || p.month > series[i - 1].month);
  if (!metaOk) {
    seriesFail++;
    const last = series[series.length - 1];
    console.log(
      `  x ${s.name}(${s.code}) 元信息不一致: n=${series.length}/${s.span} ` +
      `${series[0] && series[0].month}~${last && last.month} vs ${s.first}~${s.last}`
    );
  }
}
check('全部标的解码后自洽（正价格 / 月份严格递增 / 首末一致）', seriesFail === 0, `${seriesFail} 个异常`);
check('确有标的存在停牌缺口（缺月处理被真正用到）', gapsFound > 0, `${gapsFound} 个标的带缺口`);

const yearsAll = spans.map((n) => n / 12);
check('至少 40 个标的历史超过 10 年', yearsAll.filter((y) => y >= 10).length >= 40,
  `实际 ${yearsAll.filter((y) => y >= 10).length}`);
check('至少 1 个标的历史超过 30 年', Math.max(...yearsAll) >= 30, `最长 ${Math.max(...yearsAll).toFixed(1)} 年`);
check('所有序列价格均为正（后复权的基本属性）',
  DB.stocks.every((s) => decodeStockRecord(s, DB.scale).every((p) => p.close > 0)));

// ── 3. 计算引擎 ────────────────────────────────────────────
const compute = await import(pathToFileURL(path.join(DOCS, 'js', 'compute.js')).href);
const { irr, simulate, normalizeSeries, monthIndex, monthLabel, simulateFromParams } = compute;

check('monthIndex/monthLabel 互逆',
  ['1999-01', '2007-10', '2016-01', '2026-10'].every((m) => monthLabel(monthIndex(m)) === m));

// 3.1 IRR 闭式解与极端情形
{
  near(irr([-100, ...Array(11).fill(0), 110], 12), 0.1, 1e-6, 'IRR：单笔一年 +10%');
  near(irr([-100, ...Array(23).fill(0), 200], 12), Math.SQRT2 - 1, 1e-6, 'IRR：两年翻倍 = sqrt(2)-1');
  near(irr([-100, ...Array(11).fill(0), 50], 12), -0.5, 1e-6, 'IRR：一年亏 50%');
  near(irr([-100, ...Array(119).fill(0), 300], 12), Math.pow(3, 1 / 10) - 1, 1e-6, 'IRR：十年三倍');
  near(irr([...Array(24).fill(-1000), 24000], 12), 0, 1e-9, 'IRR：等比定投零收益');

  // 极端亏损：期末变现额远小于月供 —— 这是曾经返回 NaN 的支路
  // 投 3000 只拿回 1000，月率 = -2/3，年化 = (1/3)^12 - 1
  near(irr([-3000, 1000], 12), Math.pow(1 / 3, 12) - 1, 1e-6, 'IRR：期末只拿回 1/3（曾返回 NaN）');
  check('IRR：极端亏损结果优于 -100% 且为有限数',
    Number.isFinite(irr([-3000, 1000], 12)) && irr([-3000, 1000], 12) > -1,
    String(irr([-3000, 1000], 12)));

  // 全损：只投入、没有任何回收 → 恰好 -100%，不能是 NaN
  check('IRR：全损（回收为 0）返回 -100%', irr([-1000, -1000, 0], 12) === -1, String(irr([-1000, -1000, 0], 12)));
  check('IRR：只有投入无回收返回 -100%', irr([-100, -100], 12) === -1, String(irr([-100, -100], 12)));
  check('IRR：只有回收无投入返回 NaN', Number.isNaN(irr([100, 100], 12)));
  check('IRR：空数组返回 NaN', Number.isNaN(irr([], 12)));

  // 单期年化：1 期就赚 10% 意味着月率 10%，年化应为 1.1^12 - 1。
  // 这类"只有一笔成交"的区间曾经整体返回 NaN（见 compute.js 的 irr 兜底）。
  const one = irr([-1000, 1100], 12);
  near(one, Math.pow(1.1, 12) - 1, 1e-9, 'IRR：单期 +10% 年化 = 1.1^12 - 1');
  check('IRR：单期结果不再退化成 NaN', Number.isFinite(one));
}

// 3.2 定投手工推导
{
  const flat = normalizeSeries(Array.from({ length: 24 }, (_, i) => ({
    month: monthLabel(monthIndex('2020-01') + i),
    close: 10,
  })));
  const r = simulate({ series: flat, startMonth: '2020-01', months: 24, amount: 1000 });
  near(r.summary.totalInvested, 24000, 1e-9, '恒定价格：累计投入 24000');
  near(r.summary.profit, 0, 1e-9, '恒定价格：盈亏 0');
  near(r.summary.finalShares, 2400, 1e-9, '恒定价格：份额 2400');
  near(r.summary.annualized, 0, 1e-6, '恒定价格：年化 0');

  const rising = flat.map((p, i) => ({ ...p, price: i === 23 ? 11 : 10 }));
  const r2 = simulate({ series: rising, startMonth: '2020-01', months: 24, amount: 1000 });
  // 前 23 期在 10 元各买 100 份（2300 份），末月 1000 元在 11 元买入 1000/11 份
  const expectShares = 2300 + 1000 / 11;
  near(r2.summary.finalShares, expectShares, 1e-9, '末月涨到 11：份额核对');
  near(r2.summary.finalValue, expectShares * 11, 1e-6, '末月涨到 11：市值核对');
  near(r2.summary.profit, r2.summary.finalValue - 24000, 1e-6, '末月涨到 11：盈亏核对');
  near(r2.summary.totalReturn, (expectShares * 11 - 24000) / 24000, 1e-9, '末月涨到 11：总收益率核对');
  check('资金加权年化落在合理区间',
    // 定投是分批投入：末期资金只站岗一个月，所以年化会略高于"总收益率"这个简单口径，
    // 但不能高得离谱。这里用 ±30% 的相对带做护栏。
    r2.summary.annualized > 0 && r2.summary.annualized < r2.summary.totalReturn * 1.3,
    `年化 ${(r2.summary.annualized * 100).toFixed(3)}% vs 总收益 ${(r2.summary.totalReturn * 100).toFixed(3)}%`);
  // 用"每期定额投入 + 复利折现"的独立写法复核年化：
  // 等额年金 PV = 期末市值 PV，两边都按同一个年化率折现
  const mRate2 = Math.pow(1 + r2.summary.annualized, 1 / 12) - 1;
  let pvIn = 0;
  for (let i = 0; i < 24; i++) pvIn += 1000 / Math.pow(1 + mRate2, i);
  const pvOut = r2.summary.finalValue / Math.pow(1 + mRate2, 23);
  near(pvIn, pvOut, 1e-6, '末月涨到 11：投入现值 = 期末市值现值');
  // 期末月份必须锚定在"最后一笔买入的月份"，而不是数据末尾
  check('期末月份 = 最后一笔买入月', r2.summary.endMonth === '2021-12', r2.summary.endMonth);
}

// 3.3 IRR 与现金流自洽（NPV 回代必须为 0）
{
  const series = normalizeSeries(Array.from({ length: 12 }, (_, i) => ({
    month: monthLabel(monthIndex('2021-01') + i),
    close: i === 11 ? 12 : 10,
  })));
  const r = simulate({ series, startMonth: '2021-01', months: 12, amount: 1000 });
  const shares = 1100 + 1000 / 12;
  near(r.summary.finalShares, shares, 1e-6, '手工份额核对（11 期@10 元 + 1 期@12 元）');
  near(r.summary.finalValue, shares * 12, 1e-4, '手工市值核对');
  const mRate = Math.pow(1 + r.summary.annualized, 1 / 12) - 1;
  let npv = 0;
  // 现金流按"每期期末"发生：第 i 笔投入在 t=i 折现，期末变现发生在 t=11
  for (let i = 0; i < 12; i++) npv -= 1000 / Math.pow(1 + mRate, i);
  npv += (shares * 12) / Math.pow(1 + mRate, 11);
  near(npv, 0, 1e-6, 'IRR 反查 NPV ~ 0');

  // 现金流结构：每期为投入（负），末期还要叠加"期末变现"（正），
  // 所以末期净额 = 期末市值 - 当月投入
  const negSum = r.flows.filter((f) => f < 0).reduce((acc, v) => acc + v, 0);
  near(-negSum, r.summary.totalInvested - 1000, 1e-6, '负现金流合计 = 累计投入 − 末期投入');
  near(r.flows[r.flows.length - 1], r.summary.finalValue - 1000, 1e-6, '末期现金流 = 期末市值 − 当月投入');
  near(r.flows.length, 12, 1e-9, '现金流期数 = 12');
}

// 3.4 手续费
{
  const series = normalizeSeries(Array.from({ length: 12 }, (_, i) => ({
    month: monthLabel(monthIndex('2021-01') + i),
    close: 10,
  })));
  const noFee = simulate({ series, startMonth: '2021-01', months: 12, amount: 1000 });
  const withFee = simulate({ series, startMonth: '2021-01', months: 12, amount: 1000, feeEnabled: true, feeRate: 0.00025, feeMin: 5 });
  check('手续费让期末市值下降', withFee.summary.finalValue < noFee.summary.finalValue);
  near(withFee.summary.fees, 60, 1e-9, '12 期 x 最低手续费 5 元 = 60 元');
  near(withFee.summary.totalInvested, noFee.summary.totalInvested, 1e-9, '手续费不改变累计投入口径');
}

// 3.5 真实数据端到端（贵州茅台 2015-01 -> 2025-01）
{
  const rec = DB.stocks.find((s) => s.code === '600519');
  check('数据库含贵州茅台', !!rec);
  const stock = { ...rec, decodedSeries: decodeStockRecord(rec, DB.scale) };
  const r = simulateFromParams(stock, { startMonth: '2015-01', endMonth: '2025-01', amount: 5000, feeEnabled: false });
  check('茅台 2015-01->2025-01 共 121 期', r.summary.months === 121, `实际 ${r.summary.months}`);
  near(r.summary.totalInvested, 5000 * 121, 1e-6, '累计投入 = 60.5 万');
  check('收益率均为有限数', Number.isFinite(r.summary.annualized) && Number.isFinite(r.summary.totalReturn));
  check('逐月累计投入单调不减', r.curve.every((p, i) => i === 0 || p.invested >= r.curve[i - 1].invested));
  check('最大回撤落在 [0,1)',
    Number.isFinite(r.summary.maxDrawdown) && r.summary.maxDrawdown >= 0 && r.summary.maxDrawdown < 1,
    `回撤 ${r.summary.maxDrawdown}，曲线 ${r.curve.length} 点，期内 ${r.curve.filter((p) => p.inPeriod).length} 点`);
  check('定投期内曲线点数 = 自然月数',
    r.curve.filter((p) => p.inPeriod).length === r.summary.calendarMonths,
    `${r.curve.filter((p) => p.inPeriod).length} vs ${r.summary.calendarMonths}`);
  check('曲线允许延伸到最新行情（点数 >= 定投期内点数）', r.curve.length >= r.summary.calendarMonths);
  check('期末持股 = 各期买入份额之和',
    Math.abs(r.summary.finalShares - r.trades.reduce((acc, t) => acc + t.shares, 0)) < 1e-9);
  console.log(
    `     茅台 2015-01->2025-01 每月 5000 元：投入 ${(r.summary.totalInvested / 10000).toFixed(1)} 万，` +
    `市值 ${(r.summary.finalValue / 10000).toFixed(1)} 万，总收益 ${(r.summary.totalReturn * 100).toFixed(1)}%，` +
    `年化 ${(r.summary.annualized * 100).toFixed(2)}%，最大回撤 -${(r.summary.maxDrawdown * 100).toFixed(1)}%`
  );
}

// 3.6 区间裁剪：开始时间早于上市日
{
  const rec = DB.stocks.find((s) => s.code === '688981'); // 中芯国际 2020-07 上市
  const stock = { ...rec, decodedSeries: decodeStockRecord(rec, DB.scale) };
  const r = simulateFromParams(stock, { startMonth: '1995-01', endMonth: '2021-01', amount: 1000 });
  check('早于上市日的开始月被裁剪到上市首月', r.summary.startMonth === rec.first, `${r.summary.startMonth} vs ${rec.first}`);
}

// 3.7 全库压力测试：每只标的都用同一个区间跑一遍，不允许抛错或产生 NaN
{
  let bad = 0;
  const results = [];
  for (const rec of DB.stocks) {
    try {
      const stock = { ...rec, decodedSeries: decodeStockRecord(rec, DB.scale) };
      const end = rec.last;
      const startMi = Math.max(monthIndex(rec.first), monthIndex(end) - 119);
      const r = simulateFromParams(stock, { startMonth: monthLabel(startMi), endMonth: end, amount: 3000, feeEnabled: true });
      const s = r.summary;
      const ok = Number.isFinite(s.annualized) && Number.isFinite(s.finalValue) && s.finalValue > 0 &&
        s.totalInvested > 0 && s.maxDrawdown >= 0 && s.maxDrawdown <= 1 &&
        r.curve.length > 0 && r.trades.length === s.months;
      if (!ok) {
        bad++;
        console.log(`  x ${rec.name}(${rec.code}) 结果异常: 年化=${s.annualized} 市值=${s.finalValue} 回撤=${s.maxDrawdown}`);
      }
      results.push({ name: rec.name, code: rec.code, annualized: s.annualized, years: s.years });
    } catch (err) {
      bad++;
      console.log(`  x ${rec.name}(${rec.code}) 抛错：${err.message}`);
    }
  }
  check(`全库 ${DB.stocks.length} 只标的近 10 年定投均可算出合理结果`, bad === 0, `${bad} 只异常`);

  const insane = results.filter((r) => Math.abs(r.annualized) > 1);
  check('没有出现 |年化| > 100% 的离谱结果', insane.length === 0,
    insane.map((r) => `${r.name} ${(r.annualized * 100).toFixed(0)}%`).join(', '));

  const sorted = [...results].sort((a, b) => b.annualized - a.annualized);
  console.log('\n     近 10 年（或上市以来）每月 3000 元定投年化排行榜：');
  for (const r of [...sorted.slice(0, 3), ...sorted.slice(-3)]) {
    console.log(`       ${r.annualized >= 0 ? '+' : ''}${(r.annualized * 100).toFixed(2)}%  ${r.name}（${r.code}） ${r.years.toFixed(1)} 年`);
  }
}

// 3.8 全库 x 随机参数的自洽性审计
//     收益数字算错是"用户看不出来"的错误，所以这里不比对期望值，
//     而是检查一堆必须成立的恒等式，任何一条破了都说明引擎内部不一致。
{
  // 固定种子的线性同余，保证每次跑的参数完全一样（可复现）
  let seed = 20261016;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

  let cases = 0;
  let violations = 0;
  const details = [];
  const sample = [...DB.stocks].sort(() => rnd() - 0.5).slice(0, 24);

  for (const rec of sample) {
    const series = decodeStockRecord(rec, DB.scale);
    const stock = { ...rec, decodedSeries: series };
    const firstMi = monthIndex(rec.first);
    const lastMi = monthIndex(rec.last);
    if (lastMi - firstMi < 3) continue;

    for (let k = 0; k < 3; k++) {
      const sMi = firstMi + Math.floor(rnd() * Math.max(1, lastMi - firstMi - 2));
      const eMi = sMi + 1 + Math.floor(rnd() * (lastMi - sMi));
      const amount = [1, 137, 1000, 3000, 20000, 123456][Math.floor(rnd() * 6)];
      const feeEnabled = rnd() > 0.5;
      let r;
      try {
        r = simulateFromParams(stock, {
          startMonth: monthLabel(sMi), endMonth: monthLabel(eMi), amount,
          feeEnabled, feeRate: 0.00025, feeMin: 5,
        });
      } catch (err) {
        violations++;
        details.push(`${rec.name} ${monthLabel(sMi)}~${monthLabel(eMi)} 抛错: ${err.message}`);
        continue;
      }
      cases++;
      const s = r.summary;
      const bad = [];

      // 恒等式 1：累计投入 = 各期投入之和
      const sumAmount = r.trades.reduce((a, t) => a + t.amount, 0);
      if (Math.abs(sumAmount - s.totalInvested) > 1e-6) bad.push(`投入不平 ${sumAmount} vs ${s.totalInvested}`);

      // 恒等式 2：期末市值 = 期末份额 x 期末价 + 闲钱
      if (Math.abs(s.finalShares * s.endPrice + s.idleCash - s.finalValue) > 1e-6) {
        bad.push(`市值不平 ${s.finalShares * s.endPrice + s.idleCash} vs ${s.finalValue}`);
      }

      // 恒等式 3：盈亏 = 市值 - 投入
      if (Math.abs(s.profit - (s.finalValue - s.totalInvested)) > 1e-6) bad.push('盈亏不平');

      // 恒等式 4：收益率 = 盈亏 / 投入
      if (Math.abs(s.totalReturn - s.profit / s.totalInvested) > 1e-9) bad.push('收益率不平');

      // 恒等式 5：曲线的最后一个"期内"点必须等于期末结算值
      const inPeriod = r.curve.filter((p) => p.inPeriod);
      const lastPoint = inPeriod[inPeriod.length - 1];
      if (!lastPoint) bad.push('曲线没有期内点');
      else if (Math.abs(lastPoint.value - s.finalValue) > 1e-6) {
        bad.push(`曲线末点 ${lastPoint.value} vs 期末市值 ${s.finalValue}`);
      }

      // 恒等式 6：IRR 反查 NPV ≈ 0（用引擎自己的现金流，核对自己的年化）
      if (Number.isFinite(s.annualized) && s.totalInvested > 0 && s.finalValue > 0) {
        const mRate = Math.pow(1 + s.annualized, 1 / 12) - 1;
        const zeroMi = Math.min(...r.trades.map((t) => t.mi));
        let npv = 0;
        for (const t of r.trades) npv -= t.amount / Math.pow(1 + mRate, t.mi - zeroMi);
        const lastMiUsed = Math.max(...r.trades.map((t) => t.mi));
        npv += s.finalValue / Math.pow(1 + mRate, lastMiUsed - zeroMi);
        // 放宽到 1e-4：多次折现的浮点累积误差
        if (Math.abs(npv) > 1e-4) bad.push(`IRR 反查 NPV=${npv}`);
      } else if (!(s.totalInvested > 0)) {
        bad.push('累计投入非正');
      }

      // 恒等式 7：所有关键数字必须是有限数
      for (const [kk, vv] of Object.entries(s)) {
        if (typeof vv === 'number' && !Number.isFinite(vv) && kk !== 'annualized' && kk !== 'lumpy') {
          // annualized 允许 NaN（极端亏损无解），其余不允许
          bad.push(`${kk}=${vv}`);
        }
      }

      // 恒等式 8：最大回撤必须在 [0,1]
      if (!(s.maxDrawdown >= 0 && s.maxDrawdown <= 1)) bad.push(`回撤 ${s.maxDrawdown}`);

      // 恒等式 9：开了手续费，市值不可能高于不开
      if (feeEnabled) {
        const noFee = simulateFromParams(stock, {
          startMonth: monthLabel(sMi), endMonth: monthLabel(eMi), amount, feeEnabled: false,
        });
        if (s.finalValue > noFee.summary.finalValue + 1e-6) bad.push('开手续费后市值反而更高');
      }

      if (bad.length) {
        violations++;
        details.push(`${rec.name}(${rec.code}) ${s.startMonth}~${s.endMonth} 金额${amount}${feeEnabled ? '+费' : ''}: ${bad.join('; ')}`);
      }
    }
  }

  check(`全库随机参数自洽性审计（${cases} 个组合）`, violations === 0, details.slice(0, 6).join(' | '));
  console.log(`     随机审计覆盖 ${sample.length} 只标的、${cases} 组参数，恒等式违反 ${violations} 次`);
}

// ── 4. 称号与成就 ──────────────────────────────────────────
{
  const achMod = await import(pathToFileURL(path.join(DOCS, 'js', 'achievements.js')).href);
  const { pickRank, evaluateAchievements, RANKS, ACHIEVEMENTS } = achMod;

  check('称号阶梯按年化降序排列', RANKS.every((r, i) => i === 0 || r.min < RANKS[i - 1].min));
  check('称号阶梯最后一档兜底 -Infinity', RANKS[RANKS.length - 1].min === -Infinity);
  check('每个称号都有 emoji/quote/desc', RANKS.every((r) => r.emoji && r.quote && r.desc && r.title));
  check('成就 id 唯一', new Set(ACHIEVEMENTS.map((a) => a.id)).size === ACHIEVEMENTS.length);
  check('成就 rarities 合法', ACHIEVEMENTS.every((a) => ['common', 'rare', 'epic', 'legend'].includes(a.rarity)));

  check('年化 80% -> 吧菲特附体', pickRank(0.8, 3, 5).key === 'god');
  check('年化 20% -> 价投及格生', pickRank(0.2, 1, 5).key === 'grader');
  check('年化 -60% -> 销户跑路预备役', pickRank(-0.6, -0.9, 5).key === 'abyss');
  check('年化 -25% -> 韭菜中的韭菜', pickRank(-0.25, -0.8, 5).key === 'leekking');
  check('年化 NaN -> 兜底不抛错', !!pickRank(NaN, 0, 1));
  check('长期 + 擦线年化会被照顾升档', pickRank(0.148, 3, 10).key === 'grader');
  check('短期同样年化不升档', pickRank(0.148, 0.5, 3).key === 'winner');

  const baseSummary = {
    totalReturn: 0, profit: 0, annualized: 0, months: 12, totalInvested: 36000, finalValue: 36000,
    marketReturn: 0, lumpReturn: 0, worstProfitRate: 0, avgBuyPercentile: 0.5, idleCash: 0,
    maxDrawdown: 0, finalShares: 0, fees: 0,
    startMonth: '2020-01', endMonth: '2020-12',
  };
  // 夹具必须与 app.js 里生产的 ctx 形状一致：monetary 字段全在 summary 下，
  // 顶层只放标的元信息与基准数据。
  // 之前这里在顶层多塞了一个 maxDrawdown，正好把"成就读了不存在的字段"这个 bug 掩盖住了。
  const mkCtx = (over = {}) => ({
    summary: { ...baseSummary },
    trades: [],
    stockCode: '600519',
    stockName: '贵州茅台',
    stockFirstMonth: '2001-08',
    stockLastMonth: '2026-10',
    feeEnabled: false,
    hasBenchmark: false,
    benchmarkAnnualized: NaN,
    tradesTouched: () => false,
    startYearMonth: () => 0,
    ...over,
  });

  // 生产 ctx 的形状契约：顶层只能是标的/基准元信息与两个辅助方法，
  // 任何"金额/回撤/份额"之类的派生指标都必须挂在 summary 下。
  const PRODUCTION_TOP_KEYS = new Set([
    'summary', 'trades', 'yearly', 'curve', 'flows', 'warnings',
    'stockCode', 'stockName', 'stockFirstMonth', 'stockLastMonth',
    'feeEnabled', 'hasBenchmark', 'benchmarkAnnualized', 'rangeStart', 'rangeEnd',
    'tradesTouched', 'startYearMonth',
  ]);
  const ctx = mkCtx();
  const extraTop = Object.keys(ctx).filter((k) => !PRODUCTION_TOP_KEYS.has(k) && !k.startsWith('__'));
  check('成就夹具的顶层字段与生产 ctx 一致', extraTop.length === 0, `多余字段：${extraTop.join(', ')}`);

  // 逐项跑一遍所有成就，确保没有任何一个 test() 抛异常（字段名写错就会命中 undefined）
  let threw = 0;
  for (const a of ACHIEVEMENTS) {
    try { a.test(mkCtx()); } catch (e) { threw++; console.log(`    成就 ${a.id} 抛错: ${e.message}`); }
  }
  check(`全部 ${ACHIEVEMENTS.length} 个成就的判定函数都能安全执行`, threw === 0, `${threw} 个抛错`);

  // 回撤 66% 的账户必须解锁「钻石手」——这条曾经因为读错字段而永远为 false
  const leek = evaluateAchievements(mkCtx({
    summary: { ...baseSummary, totalReturn: -0.62, profit: -22000, annualized: -0.5, months: 40, maxDrawdown: 0.66 },
  }));
  check('惨烈韭菜解锁"腰斩体验官"', leek.unlocked.some((a) => a.id === 'loss_half'));
  check('惨烈韭菜解锁"钻石手"（回撤 66%、40 期）', leek.unlocked.some((a) => a.id === 'diamond_hands'));
  check('惨烈韭菜不该解锁"高位接盘侠"（分位 0.5）', !leek.unlocked.some((a) => a.id === 'buy_high'));
  check('零持股不该解锁"精准抄底"（分位 0 的退化情形）',
    !evaluateAchievements(mkCtx({ summary: { ...baseSummary, finalShares: 0, avgBuyPercentile: 0 } }))
      .unlocked.some((a) => a.id === 'buy_low'));

  const god = evaluateAchievements(mkCtx({
    summary: {
      ...baseSummary, totalReturn: 5.2, profit: 900000, annualized: 0.45, months: 130,
      totalInvested: 390000, finalValue: 1290000, marketReturn: 3, lumpReturn: 3,
      avgBuyPercentile: 0.1, idleCash: 350, maxDrawdown: 0.45, finalShares: 1000, fees: 320,
    },
    tradesTouched: () => true,
    hasBenchmark: true,
    benchmarkAnnualized: 0.1,
  }));
  check('神话账户解锁"五倍传说"', god.unlocked.some((a) => a.id === 'profit_five'));
  check('神话账户解锁"A股钉子户"', god.unlocked.some((a) => a.id === 'ten_years'));
  check('神话账户解锁"钻石手"', god.unlocked.some((a) => a.id === 'diamond_hands'));
  check('神话账户解锁"精准抄底"', god.unlocked.some((a) => a.id === 'buy_low'));
  check('神话账户解锁"养活了券商"（手续费 320 元）', god.unlocked.some((a) => a.id === 'fee_eater'));
  check('神话账户解锁彩蛋"塑化剂里捡茅台"', god.unlocked.some((a) => a.id === 'moutai_2013'));
  check('神话账户解锁"跑赢沪深300"', god.unlocked.some((a) => a.id === 'beats_index'));
  check('神话账户成就分高于韭菜', god.score > leek.score, `${god.score} vs ${leek.score}`);
  check('未解锁项与已解锁项不重叠', !god.unlocked.some((u) => god.locked.some((l) => l.id === u.id)));

  const noBench = evaluateAchievements(mkCtx({ summary: { ...baseSummary, totalReturn: 1, annualized: 0.3 } }));
  check('无基准数据时 beats_index 被锁定', noBench.locked.some((a) => a.id === 'beats_index' && a.lockedReason));

  // 年化无解时的称号兜底：亏损账户不能拿到中性称号
  const nanLoss = pickRank(NaN, -0.9, 3);
  check('年化 NaN + 总收益 -90% → 落到亏损档而不是中性档',
    ['leekking', 'rooftop', 'abyss', 'midleek'].includes(nanLoss.key), nanLoss.key);
  const nanZeroYears = pickRank(NaN, 0.1, 0);
  check('年化 NaN + 期限 0 → 不抛错', !!nanZeroYears && !!nanZeroYears.title);

  const stats = achMod.achievementStats();
  check('成就统计与列表一致', stats.total === ACHIEVEMENTS.length && stats.ranks === RANKS.length,
    JSON.stringify(stats));
}

// ── 汇总 ───────────────────────────────────────────────────
console.log(`\n自检：${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('失败明细：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
