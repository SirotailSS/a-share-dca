// 成就可解锁性全面扫描：确认没有"永远拿不到"的徽章
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const DOCS = path.resolve('docs');
const sb = { window: {} };
vm.createContext(sb);
vm.runInContext(await fs.readFile(path.join(DOCS, 'data', 'stocks.js'), 'utf8'), sb);
const DB = sb.window.__DCA_DB__;
const { decodeStockRecord } = await import(pathToFileURL(path.join(DOCS, 'js', 'decode.js')).href);
const { simulateFromParams, monthIndex, monthLabel } = await import(pathToFileURL(path.join(DOCS, 'js', 'compute.js')).href);
const { evaluateAchievements, ACHIEVEMENTS, RANKS, achievementStats } = await import(
  pathToFileURL(path.join(DOCS, 'js', 'achievements.js')).href
);

console.log('成就统计:', JSON.stringify(achievementStats()));

const unlocked = new Map();
let combos = 0;

const windows = [
  ['first-5y', 0, 60], ['last-10y', -120, 0], ['all', 0, null],
  ['2007-2010', null, null], ['2015-2019', null, null], ['2021-now', null, null],
];
const starts = [['2007-01'], ['2008-06'], ['2012-11'], ['2015-04'], ['2020-02'], ['2022-03'], ['2024-08']];

for (const rec of DB.stocks) {
  const series = decodeStockRecord(rec, DB.scale);
  const stock = { ...rec, decodedSeries: series };
  const fMi = monthIndex(rec.first);
  const lMi = monthIndex(rec.last);
  const tryOne = (s, e, amount, feeEnabled) => {
    if (monthIndex(e) < monthIndex(s)) return;
    let r;
    try {
      r = simulateFromParams(stock, { startMonth: s, endMonth: e, amount, feeEnabled, feeRate: 0.00025, feeMin: 5 });
    } catch { return; }
    const ctx = {
      ...r,
      stockCode: rec.code, stockName: rec.name,
      stockFirstMonth: rec.first, stockLastMonth: rec.last,
      feeEnabled, hasBenchmark: true, benchmarkAnnualized: 0.03,
      tradesTouched: (a, b) => r.trades.some((t) => t.mi >= a && t.mi <= b),
      startYearMonth: (ym) => monthIndex(ym),
    };
    combos++;
    for (const a of evaluateAchievements(ctx).unlocked) {
      if (!unlocked.has(a.id)) unlocked.set(a.id, `${rec.name}(${rec.code}) ${r.summary.startMonth}~${r.summary.endMonth} 每月${amount}${feeEnabled ? '+费' : ''}`);
    }
  };

  // 全历史 + 各档金额 + 手续费
  for (const [s, e] of [['first-5y', 60], ['last-10y', 120], ['all', null]]) {
    const start = monthLabel(fMi);
    const end = monthLabel(e == null ? lMi : Math.min(lMi, fMi + e - 1));
    if (s === 'last-10y') { const sm = Math.max(fMi, lMi - 119); tryOne(monthLabel(sm), monthLabel(lMi), 3000, false); tryOne(monthLabel(sm), monthLabel(lMi), 100000, true); continue; }
    tryOne(start, end, 1000, false);
    tryOne(start, end, 3000, false);
    tryOne(start, end, 30000, false);
    tryOne(start, end, 3000, true);
    tryOne(start, end, 50000, true);
  }
  // 事件窗口：从每个关键月份开始投到数据末尾
  for (const [st] of starts) {
    const mi = monthIndex(st);
    if (mi >= fMi && mi <= lMi) {
      tryOne(st, monthLabel(lMi), 3000, false);
      tryOne(st, monthLabel(lMi), 3000, true);
    }
  }
  // 短窗口：制造大回撤/大亏损
  for (const months of [1, 2, 3, 6, 12, 24, 36]) {
    for (let k = 0; k + months <= series.length; k += 7) {
      tryOne(monthLabel(fMi + k), monthLabel(fMi + k + months - 1), 3000, false);
    }
  }
}

console.log(`\n扫描组合数: ${combos}`);
console.log(`可解锁徽章: ${unlocked.size} / ${ACHIEVEMENTS.length}`);
const never = ACHIEVEMENTS.filter((a) => !unlocked.has(a.id));
if (never.length) {
  console.log('\n❌ 穷举后仍无法解锁的徽章（死代码）：');
  for (const a of never) console.log(`   ${a.emoji} ${a.id} — ${a.name}：${a.desc}`);
} else {
  console.log('\n✅ 所有徽章都存在可达路径');
}
console.log('\n各徽章的一个可达样例：');
for (const a of ACHIEVEMENTS) {
  if (unlocked.has(a.id)) console.log(`   ${a.emoji} ${a.name.padEnd(14, '　')} ← ${unlocked.get(a.id)}`);
}
console.log(`\n称号档位数: ${RANKS.length}`);
process.exit(never.length ? 1 : 0);
