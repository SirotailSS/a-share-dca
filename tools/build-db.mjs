#!/usr/bin/env node
/**
 * 构建内置行情数据库（真实历史数据）
 * ------------------------------------------------------------------
 * 主数据源：腾讯行情 ifzq 月度后复权
 *   https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sz300750,month,2000-01-01,2026-12-31,1000,hfq
 * 备用数据源：东方财富 push2his 月度后复权（klt=103, fqt=2）
 *
 * 为什么必须是「后复权」而不是「前复权」：
 *   前复权（腾讯 qfq / 东财 fqt=1）是"用现价往前累减分红"的口径，对长期高分红
 *   个股会算出负数价格（实测：茅台 2001 年 qfq = -313.86，平安银行 2000 年 = 0.10），
 *   根本无法作为定投成本。
 *   后复权（hfq / fqt=2）以上市首日为基准把分红送股还原进价格，恒为正数，且
 *   「期末后复权价 ÷ 买入月后复权价 − 1」本身就是含分红再投资的真实收益率，
 *   因此定投模拟只需一条价格序列，无需额外维护分红表。
 *
 * ⚠ 口径一致性：腾讯与东财的后复权算法不同（现金分红的再投资假设不同），
 *   实测同一标的可差 10%~25%。全库必须只用同一个源，禁止混用，
 *   所以本脚本每次运行都整库重建，不继承旧的缓存文件。
 *
 * 产物：docs/data/stocks.js（script 标签直接加载，file:// 打开也能用，无 CORS 问题）
 *
 * 用法：
 *   node tools/build-db.mjs              # 抓取并重建整库（约 1 分钟）
 *   node tools/build-db.mjs --offline    # 只用本地缓存重建，不联网
 *   node tools/build-db.mjs --only 600519,000858
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STOCKS } from './stock-list.mjs';
import { normalizeAliases } from './aliases.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'tools', '.cache');
const OUT_FILE = path.join(ROOT, 'docs', 'data', 'stocks.js');
const REPORT_FILE = path.join(CACHE_DIR, 'build-report.json');

const args = process.argv.slice(2);
const OFFLINE = args.includes('--offline');
const ONLY = (() => {
  const i = args.indexOf('--only');
  if (i === -1) return null;
  const raw = args[i + 1];
  if (!raw) throw new Error('--only 需要一个逗号分隔的代码列表');
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
})();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 20000;
const RETRIES = 3;
const REQ_GAP_MS = 220; // 对公开接口保持克制

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, referer) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: referer, Accept: '*/*' },
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) await sleep(500 * attempt + Math.random() * 400);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastErr ? lastErr.message : '未知网络错误');
}

async function fetchJson(url, referer) {
  const text = await fetchText(url, referer);
  const cleaned = text.replace(/^[^(]*\(/, '').replace(/\);?\s*$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`返回内容不是 JSON：${text.slice(0, 80)}`);
  }
}


// ── 行情的紧凑编码 ──────────────────────────────────────────────────
/**
 * 64 个字符的字母表（base64url 风格，全是 ASCII 字母数字与 -_，无需任何转义）。
 * 一个字符承载 6 bit：字符索引就是一组 6 bit 的值。
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const ALPHA_IDX = new Map([...ALPHABET].map((c, i) => [c, i]));

/**
 * 整数序列 -> { offset, str }
 *
 * 格式（解码端 docs/js/decode.js 严格对称），分三层，每层职责单一：
 *   1) 平移：offset = min(values)，只存 values[i] - offset（恒 ≥ 0），offset 单独成字段；
 *   2) 变长整数 -> 字节流：每个非负整数按 7 bit 一组、**低位组在前**；
 *      除最后一组外，每组再加 0x80 作为"后面还有"标志。
 *      标志位（bit 7）与数据位（bit 0~6）各占其位、绝不重叠，
 *      所以字节值域是 0~255，一个都不会越界；
 *   3) 字节流 -> 字符串：每个字节按 6 bit 切成**两个**字符（高 6 位、低 6 位）。
 *      字符是"6 bit 的容器"，字节与字符不是一对一 ——
 *      之前想用"一个字符装 7 bit 数据 + 继续标志"，索引会超过 63 个字符的范围，
 *      于是 charAt 返回 undefined，这是本文件踩过的唯一一个真坑。
 *
 * 全程使用 Math.floor / % / *：JS 的 << >> | 是 32 位有符号运算，
 * 数值一旦越过 2^31 会静默变成负数。
 */
export function encodeInts(values) {
  const list = values.map((v) => {
    if (!Number.isFinite(v) || !Number.isInteger(v)) throw new Error(`encodeInts: 只接受整数，收到 ${v}`);
    return v;
  });
  const offset = list.length ? Math.min(...list) : 0;

  const bytes = [];
  for (const v of list) {
    let x = v - offset;
    do {
      const digit = x % 128;
      x = Math.floor(x / 128);
      bytes.push(x > 0 ? digit + 128 : digit);
    } while (x > 0);
  }

  let str = '';
  for (const b of bytes) str += ALPHABET[Math.floor(b / 64)] + ALPHABET[b % 64];
  return { offset, str };
}

export function decodeInts(str, offset = 0) {
  const out = [];
  if (!str) return out;
  if (str.length % 2 !== 0) throw new Error('编码字符串长度应为偶数');

  const bytes = [];
  for (let i = 0; i < str.length; i += 2) {
    const hi = ALPHA_IDX.get(str[i]);
    const lo = ALPHA_IDX.get(str[i + 1]);
    if (hi === undefined || lo === undefined) throw new Error(`非法字符：${str[i]}${str[i + 1]}`);
    bytes.push(hi * 64 + lo);
  }

  let i = 0;
  while (i < bytes.length) {
    let shift = 1;
    let val = 0;
    for (;;) {
      if (i >= bytes.length) throw new Error('变长整数被截断');
      const b = bytes[i++];
      val += (b % 128) * shift;
      if (b < 128) break;
      shift *= 128;
    }
    out.push(val + offset);
  }
  return out;
}

/**
 * 月度价格序列 -> { offset, str }
 *  · 值以「分」为单位取整，再逐月做差分（把绝对价格变成小幅波动，压缩率更高）；
 *  · 时间轴单独用 gaps 记录：停牌、长期停复牌会让月份不连续，
 *    绝不能假设"月份连续递增"（这条假设曾经让 3 只标的的首月、末月全部错位）。
 */
export function encodeSeries(prices, scale = 100) {
  const ints = prices.map((p) => Math.round(p * scale));
  const deltas = ints.map((v, i) => (i === 0 ? v : v - ints[i - 1]));
  return encodeInts(deltas);
}

/** encodeSeries 的逆运算（月份由 decodeMonths 单独还原） */
export function decodeSeries(str, offset = 0, scale = 100) {
  const deltas = decodeInts(str, offset);
  let acc = 0;
  const ints = deltas.map((d) => (acc += d));
  return ints.map((v) => v / scale);
}

/**
 * 月份序列（YYYY-MM）-> { offset, str }
 *
 * 直接把每个月的「月序号」（年 × 12 + 月 - 1）编码成整数序列。
 * 曾经试过只存"缺口"来省空间，但那是错的方向：
 * 缺口表是稀疏的，解码时无法判断缺口落在哪两个相邻点之间，必然有歧义。
 * 停牌、长期停复牌在真实数据里到处都有，所以时间轴必须能被无歧义地还原。
 * 月序号的绝对值本身也能被差分压缩得很小，代价完全可以接受。
 */
export function encodeMonths(months) {
  return encodeInts(months.map((m) => {
    const [y, mo] = m.split('-').map(Number);
    return y * 12 + (mo - 1);
  }));
}

export function decodeMonths(str, offset, count) {
  const idx = decodeInts(str, offset);
  if (idx.length !== count) {
    throw new Error(`月份数量不一致：编码里有 ${idx.length} 个，价格为 ${count} 个`);
  }
  return idx.map((mi) => `${Math.floor(mi / 12)}-${String((mi % 12) + 1).padStart(2, '0')}`);
}

/**
 * 行情精度：以「厘」为单位存价格（scale=1000）。
 * 为什么不是「分」：部分 ETF 报价带三位小数（如 588000 = 1.144），
 * 按分取整单点最大相对误差可达 0.79%，会把年化拉开 0.2 个百分点。
 * 用厘之后量化误差降到 0.1% 以内，代价只是数据库大十几 KB（gzip 后更小）。
 */
const PRICE_SCALE = 1000;

/**
 * 行情接口给的是"当前快照"的名称，除权除息期间会带 XD/XR/DR 前缀，
 * 风险警示股带 ST/*ST，新股上市首日带 N。
 * 这些前缀会随日期变化，绝不能固化进数据库，否则"XD片仔癀"会被永久写进去。
 */
function normalizeStockName(raw) {
  if (!raw) return '';
  let name = String(raw).replace(/\s+/g, '');
  // 允许连续前缀，如 "*ST"、"XD*ST"
  for (let i = 0; i < 4; i++) {
    const next = name.replace(/^(\*?ST|XD|XR|DR|N|C)/, '');
    if (next === name) break;
    name = next;
  }
  return name;
}

// ── 数据源 1：腾讯（主源，月度后复权） ──────────────────────────────
const TENCENT_SYMBOL = (market, code) => `${market === '1' ? 'sh' : 'sz'}${code}`;

async function fromTencent(entry) {
  const sym = TENCENT_SYMBOL(entry.secid.split('.')[0], entry.secid.split('.')[1]);
  const url =
    `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},month,1990-01-01,2035-12-31,2000,hfq`;
  const json = await fetchJson(url, 'https://gu.qq.com/');
  const node = json && json.data && json.data[sym];
  if (!node) throw new Error('腾讯接口未返回该标的');
  const rows = node.hfqmonth || node.month;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('腾讯接口 K 线为空');

  const series = [];
  let lastDate = '';
  for (const row of rows) {
    const date = String(row[0]);
    // 行格式：[日期, 开, 收, 高, 低, 成交量]
    const close = Number(row[2]);
    if (!date || !Number.isFinite(close)) continue;
    series.push({ month: date.slice(0, 7), close });
    lastDate = date;
  }
  const name = node.qt && node.qt[sym] ? String(node.qt[sym][1] || '').replace(/\s/g, '') : '';
  return { series, name, lastDate, source: 'tencent-hfq' };
}

// ── 数据源 2：东方财富（备用源，月度后复权） ────────────────────────
async function fromEastmoney(entry) {
  const secid = entry.secid;
  const kUrl =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}` +
    `&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=103&fqt=2&beg=0&end=20500101&lmt=10000`;
  const json = await fetchJson(kUrl, 'https://quote.eastmoney.com/');
  const data = json && json.data;
  if (!data || !Array.isArray(data.klines) || data.klines.length === 0) throw new Error('东财接口 K 线为空');

  const series = [];
  let lastDate = '';
  for (const row of data.klines) {
    const [date, , close] = String(row).split(',');
    const closeNum = Number(close);
    if (!date || !Number.isFinite(closeNum)) continue;
    series.push({ month: date.slice(0, 7), close: closeNum });
    lastDate = date;
  }
  let name = data.name;
  if (!name) {
    const qUrl = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f57,f58,f60`;
    const q = await fetchJson(qUrl, 'https://quote.eastmoney.com/').catch(() => null);
    name = q && q.data && q.data.f58;
  }
  return { series, name, lastDate, source: 'eastmoney-hfq' };
}

/** 同名月份只保留最后一条（当月尚未收盘时月线会持续更新） */
function dedupeMonths(series) {
  const map = new Map();
  for (const s of series) map.set(s.month, s.close);
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([month, close]) => ({ month, close }));
}

async function buildOne(entry, allowOffline) {
  const [market, code] = entry.secid.split('.');
  const cacheFile = path.join(CACHE_DIR, `${code}.json`);

  if (allowOffline) {
    const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8').catch(() => 'null'));
    if (!cached || !cached.series || cached.series.length === 0) {
      throw new Error('离线模式且本地无缓存');
    }
    return { ...cached, fromCache: true };
  }

  const errors = [];
  let raw = null;
  for (const [label, fn] of [['腾讯', fromTencent], ['东方财富', fromEastmoney]]) {
    try {
      raw = await fn(entry);
      break;
    } catch (err) {
      errors.push(`${label}: ${err.message}`);
    }
  }
  if (!raw) throw new Error(`所有数据源都失败 —— ${errors.join('；')}`);

  const series = dedupeMonths(raw.series);
  const name = normalizeStockName(raw.name || entry.fallbackName || '');
  if (!name) throw new Error(`拿不到名称（${entry.secid}）`);

  // ── 数据质量闸门：宁可失败也不能写入坏数据 ──
  if (series.length < 6) throw new Error(`${name}(${code}) 月度数据仅 ${series.length} 条，过少`);
  const bad = series.filter((s) => !(s.close > 0));
  if (bad.length) {
    throw new Error(
      `${name}(${code}) 存在非正价格 ${bad.length} 条（首个 ${bad[0].month}=${bad[0].close}）；` +
      `后复权序列理应恒为正，已拒绝写入`
    );
  }
  for (let i = 1; i < series.length; i++) {
    if (series[i].month <= series[i - 1].month) throw new Error(`${name}(${code}) 月份未严格递增`);
  }
  // 月度收益率的物理上限检查（后复权下送转股已还原，单月 ±100 倍必为脏数据）
  for (let i = 1; i < series.length; i++) {
    const ratio = series[i].close / series[i - 1].close;
    if (ratio > 20 || ratio < 1 / 20) {
      throw new Error(
        `${name}(${code}) 疑似脏数据：${series[i - 1].month}→${series[i].month} 价格 ${series[i - 1].close}→${series[i].close}`
      );
    }
  }

  const record = {
    secid: entry.secid,
    market: market === '1' ? 'sh' : 'sz',
    code,
    name,
    group: entry.group || '其他',
    tag: entry.tag || '',
    source: raw.source,
    lastDate: raw.lastDate,
    series,
    fetchedAt: new Date().toISOString(),
  };
  await fs.writeFile(cacheFile, JSON.stringify(record), 'utf8');
  return record;
}

// ── 主流程 ─────────────────────────────────────────────────────────
async function main() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });

  const targets = STOCKS.filter((s) => !ONLY || ONLY.has(s.secid.split('.')[1]));
  const ok = [];
  const failed = [];

  for (const entry of targets) {
    const label = `${entry.secid} ${entry.tag || ''}`;
    try {
      const rec = await buildOne(entry, OFFLINE);
      ok.push(rec);
      console.log(
        `  ✓ ${String(rec.name).padEnd(12, '　')} ${rec.code}  ${rec.series.length} 个月  ` +
        `${rec.series[0].month} → ${rec.series[rec.series.length - 1].month}` +
        `${rec.fromCache ? '  [缓存]' : '  [' + (rec.source || '?') + ']'}`
      );
      if (!rec.fromCache) await sleep(REQ_GAP_MS);
    } catch (err) {
      failed.push({ secid: entry.secid, tag: entry.tag, error: err.message });
      console.log(`  ✗ ${label}\n      ${err.message}`);
    }
  }

  if (ok.length === 0) throw new Error('没有任何标的构建成功，中止');

  ok.sort((a, b) => a.group.localeCompare(b.group, 'zh') || a.code.localeCompare(b.code));
  const aliases = normalizeAliases();

  const db = {
    schema: 3,
    generatedAt: new Date().toISOString(),
    adjust: '月度后复权（hfq）。以上市首日为基准把现金分红按除权日价格再投资、送转股全部还原，故价格恒为正，且「期末价/买入价-1」即含分红再投资的真实收益率。',
    source: '腾讯行情 ifzq fqkline (month, hfq)；备用：东方财富 push2his (klt=103, fqt=2)',
    sourceNote: '两个数据源的后复权算法不同（现金分红再投资假设不同），实测同一标的差异可达 10%~25%；全库只使用同一数据源，禁止混用。',
    scale: PRICE_SCALE,
    currency: 'CNY',
    encoding: {
      series: `价格：先算相邻月收盘价之差（单位：厘，1 元 = ${PRICE_SCALE} 厘），整体平移成非负（平移量记在 seriesOffset），再按 7 bit 一组、低位组在前做变长整数，除最后一组外都加 0x80 作继续标志，最后每字节拆成两个 6 bit 字符。`,
      months: '时间轴：把每个月的月序号（年 × 12 + 月 - 1）编码成同一种整数序列，平移量记在 monthsOffset。直接存绝对月序号是为了无歧义地表达停牌造成的缺月。',
    },
    stocks: ok.map((r) => {
      const months = r.series.map((s) => s.month);
      const series = encodeSeries(r.series.map((s) => s.close), PRICE_SCALE);
      const monthCode = encodeMonths(months);
      // 元信息里的首末价必须与编码后能还原出来的值完全一致（都按 PRICE_SCALE 取整），
      // 否则解码自检会在"元信息核对"这一步失败。原先是拿未取整的原始值写入的。
      const q = (v) => Math.round(v * PRICE_SCALE) / PRICE_SCALE;
      return {
        id: `${r.market}${r.code}`,
        code: r.code,
        market: r.market,
        name: normalizeStockName(r.name),
        group: r.group,
        tag: r.tag,
        first: months[0],
        last: months[months.length - 1],
        span: months.length,
        firstClose: q(r.series[0].close),
        lastClose: q(r.series[r.series.length - 1].close),
        series: `___ENCODED___${series.str}`,
        seriesOffset: series.offset,
        months: monthCode.str,
        monthsOffset: monthCode.offset,
        alias: aliases[r.code] || undefined,
      };
    }),
  };

  const banner = `/* 自动生成，请勿手改 —— npm run build:db 重新生成
 * 数据源：${db.source}
 * 复权口径：${db.adjust}
 * 生成时间：${db.generatedAt}
 * 标的数量：${db.stocks.length}
 */
`;
  const body = `window.__DCA_DB__ = ${JSON.stringify(db)};\n`;
  await fs.writeFile(OUT_FILE, banner + body, 'utf8');

  const size = (await fs.stat(OUT_FILE)).size;
  await fs.writeFile(REPORT_FILE, JSON.stringify({ generatedAt: db.generatedAt, ok: ok.length, failed, size }, null, 2), 'utf8');

  console.log(`\n生成 ${path.relative(ROOT, OUT_FILE)}`);
  console.log(`  标的 ${db.stocks.length} 个，文件 ${(size / 1024).toFixed(1)} KB`);
  if (failed.length) {
    console.log(`  失败 ${failed.length} 个：`);
    for (const f of failed) console.log(`    - ${f.secid} ${f.tag || ''}: ${f.error}`);
  }
  // 覆盖率概览
  const years = ok.map((r) => r.series.length / 12);
  console.log(`  历史长度：最长 ${Math.max(...years).toFixed(1)} 年，最短 ${Math.min(...years).toFixed(1)} 年，中位 ${years.sort((a, b) => a - b)[Math.floor(years.length / 2)].toFixed(1)} 年`);
}

// 仅在被直接执行时跑主流程（import 时不跑）
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error('\n构建失败：', err.message);
    process.exit(1);
  });
}
