/**
 * 定投计算引擎（纯函数、零依赖、可单测）
 * ================================================================
 * 价格口径：所有价格均为「后复权价」，因此
 *   1) 计算出的收益率天然包含分红再投资与送转股复权；
 *   2) 无需单独维护分红表，一套价格即可完成全部模拟。
 *
 * 定投规则（可在界面上调整）：
 *   · 每月最后一个交易日按当日收盘价买入；
 *   · 允许零股（与场内 ETF / 基金定投一致），因此结果平滑无碎股噪声；
 *   · 可选手续费：按成交额比例、且不低于单笔最低手续费（默认 0.025% / 最低 5 元）；
 *   · 手续费优先从当月现金流扣，不足则占用累积的闲钱余额。
 *
 * 年化收益率使用「资金加权收益率」XMIRR（现金流 IRR），
 * 即每笔定投按实际投入时点折现，比 (总收益/总投入/年数) 的口径准确得多，
 * 也是所有基金定投 App 里"年化收益率"的真实含义。
 */

export const YEAR_MS = 365.2425 * 24 * 3600 * 1000;

/** 'YYYY-MM' -> 距离 1970 年的月序号 */
export function monthIndex(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  return y * 12 + (m - 1);
}
/** 月序号 -> 'YYYY-MM' */
export function monthLabel(idx) {
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

/**
 * 把月度序列转成以「月序号」为键的数组，便于按区间切片。
 * @param {{month:string, close:number}[]} series
 */
export function normalizeSeries(series) {
  return series.map((p) => ({ mi: monthIndex(p.month), month: p.month, price: Number(p.close) }));
}

/**
 * 年化 IRR（资金加权收益率），符号约定：投入为负、回收为正。
 *
 * 实现要点（都踩过坑，别改回去）：
 *   · 月率下界不能取 -1+ε：当折现期数 i 较大时 (1+r)^i 会下溢成 0，
 *     远期那笔正现金流除以 0 直接得到 Infinity/NaN，二分会静默返回 NaN。
 *     这里把下界放宽到 1e-9 这种绝对无意义的月率，等价于"年化 -100%"，
 *     任何真实数据都不可能触及。
 *   · 必须先用托底利率把区间"撑开"再二分，并在找到区间后再收敛一次，
 *     否则长达 30 年、几百期现金流的情形会因初值不夹根而失败。
 *
 * @param {number[]} flows 现金流数组，flows[0] 为 t=0 时刻（通常为 0）
 * @param {number} periodsPerYear 每年期数（月度=12）
 * @returns {number} 年化收益率（小数，0.15 = 15%）；无解时返回 NaN
 */
export function irr(flows, periodsPerYear = 12) {
  const npv = (r) => {
    let s = 0;
    for (let i = 0; i < flows.length; i++) {
      if (flows[i] === 0) continue;
      s += flows[i] / Math.pow(1 + r, i);
    }
    return s;
  };
  const annualize = (rate) => Math.pow(1 + rate, periodsPerYear) - 1;

  // 必须有正有负才可能有解
  if (!flows.some((f) => f < 0) || !flows.some((f) => f > 0)) return NaN;

  // 初始区间：月率 -50% ~ +100%（对应年化约 -99.98% ~ +4095%）。
  // 下界不能取到接近 -1：那时 (1+r)^i 会下溢成 0，远端现金流除零产生 NaN，
  // 二分就会静默失败；也不能取接近 0，否则"零收益"这类根会被排除在区间之外。
  let lo = -0.5;
  let hi = 1;
  let npvLo = npv(lo);
  let npvHi = npv(hi);

  // 若初始区间没夹住根，就朝两侧逐步放宽（下限 -0.9999 是硬边界，再低没有数值意义）
  let guard = 0;
  while (npvLo * npvHi > 0 && guard++ < 80) {
    if (lo > -0.9999) {
      lo = lo > -1e-6 ? -1e-6 : -1 + (1 + lo) * 4;
      if (lo < -0.9999) lo = -0.9999;
    }
    if (hi < 1e6) hi *= 4;
    npvLo = npv(lo);
    npvHi = npv(hi);
    if (!Number.isFinite(npvLo) || !Number.isFinite(npvHi)) break;
  }
  if (!Number.isFinite(npvLo) || !Number.isFinite(npvHi) || npvLo * npvHi > 0) return NaN;

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const v = npv(mid);
    if (!Number.isFinite(v)) return NaN;
    if (v === 0) return annualize(mid);
    if (npvLo * v < 0) hi = mid;
    else { lo = mid; npvLo = v; }
  }
  return annualize((lo + hi) / 2);
}

/**
 * 定投模拟主函数。
 *
 * @param {object} opts
 * @param {{mi:number,month:string,price:number}[]} opts.series 归一化后的价格序列（后复权）
 * @param {string} opts.startMonth 'YYYY-MM'
 * @param {number} opts.months 定投期数（含首月）
 * @param {number} opts.amount 每月投入金额
 * @param {boolean} [opts.feeEnabled=false]
 * @param {number} [opts.feeRate=0.00025] 手续费率
 * @param {number} [opts.feeMin=5] 单笔最低手续费
 * @param {number} [opts.cashYield=0] 闲钱年化收益（0=闲置不计息）
 */
export function simulate(opts) {
  const { series, startMonth, months, amount, feeEnabled = false } = opts;
  const feeRate = opts.feeRate ?? 0.00025;
  const feeMin = opts.feeMin ?? 5;
  const cashYield = opts.cashYield ?? 0;

  if (!Array.isArray(series) || series.length === 0) throw new Error('价格序列为空');
  if (!(months >= 1)) throw new Error('定投期数至少为 1');
  if (!(amount > 0)) throw new Error('每月定投金额必须大于 0');

  const startMi = monthIndex(startMonth);
  const priceByMi = new Map(series.map((p) => [p.mi, p]));
  const firstMi = series[0].mi;
  const lastMi = series[series.length - 1].mi;
  const trades = [];
  const warnings = [];

  let shares = 0;
  let idleCash = 0; // 零股/手续费产生的累积余额
  let invested = 0; // 累计净投入（含手续费）
  let feesSum = 0;
  let missed = 0;
  const flowByMi = new Map(); // 月序号 -> 净现金流（投入为负）

  const monthlyCashRate = cashYield > 0 ? Math.pow(1 + cashYield, 1 / 12) - 1 : 0;

  for (let k = 0; k < months; k++) {
    const mi = startMi + k;
    const bar = priceByMi.get(mi);
    const buyPrice = bar ? bar.price : null;

    // 闲钱计息
    if (idleCash > 0 && monthlyCashRate > 0) idleCash *= 1 + monthlyCashRate;

    if (buyPrice == null) {
      // 该月无行情（未上市 / 停牌整月 / 退市），视为当月暂停并顺延，不计入投入
      missed++;
      continue;
    }

    invested += amount;
    flowByMi.set(mi, (flowByMi.get(mi) || 0) - amount);

    let budget = amount;
    let fee = 0;
    if (feeEnabled) {
      fee = Math.max(feeMin, amount * feeRate);
      if (fee > budget) fee = budget; // 极端小额保护
    }
    const buyCash = budget - fee;
    const boughtShares = buyCash / buyPrice;
    shares += boughtShares;
    feesSum += fee;
    idleCash += budget - fee - boughtShares * buyPrice; // 浮点残差留作余额

    trades.push({
      mi,
      month: bar.month,
      price: buyPrice,
      amount: budget,
      fee,
      shares: boughtShares,
      cumShares: shares,
      cumInvested: invested,
    });
  }

  if (trades.length === 0) throw new Error('所选区间内没有任何交易日行情，请检查起止时间');

  // 定投真正结束的月份 = 最后一笔买入所在月。
  // 所有"结算"口径（期末估值、IRR 现金流）都必须锚定在这里；
  // 只有展示用的曲线允许继续延伸到最新行情，否则现金流长度会和投入笔数对不上。
  const lastTradeMi = trades[trades.length - 1].mi;

  // ── 逐月市值曲线 ──────────────────────────────────────────────
  // 从定投开始月开始画（而不是从该标的上市开始），投入期画完，
  // 之后继续用真实价格跟踪持仓市值（不再投入），
  // 这样用户既能看到定投期，也能看到"如果一直拿着会怎样"。
  const curve = [];
  let sharesNow = 0;
  let investNow = 0;
  let cashNow = 0;
  let ti = 0;
  const startMiUsed = trades[0].mi;
  for (let mi = startMiUsed; mi <= lastMi; mi++) {
    if (monthlyCashRate > 0 && cashNow > 0) cashNow *= 1 + monthlyCashRate;
    if (ti < trades.length && trades[ti].mi === mi) {
      const t = trades[ti];
      sharesNow += t.shares;
      investNow += t.amount;
      cashNow += t.amount - t.fee - t.shares * t.price;
      ti++;
    }
    const bar = priceByMi.get(mi);
    if (!bar) continue;
    curve.push({
      mi,
      month: bar.month,
      price: bar.price,
      invested: investNow,
      value: sharesNow * bar.price + cashNow,
      cumShares: sharesNow,
      inPeriod: mi <= lastTradeMi,
    });
  }

  // ── 期末结算（按定投截止月的价格） ────────────────────────────
  const endBar = priceByMi.get(lastTradeMi) || series[series.length - 1];
  const priceEnd = endBar.price;
  const finalValue = shares * priceEnd + idleCash;
  // 期末把持仓"变现"记为当期正现金流，IRR 才有解
  flowByMi.set(lastTradeMi, (flowByMi.get(lastTradeMi) || 0) + finalValue);

  // 若用户在截止月之后继续持有到最新行情，顺带给出一个"持有至今"的参考市值
  const holdBar = series[series.length - 1];
  const holdValue = shares * holdBar.price + idleCash;

  // ── 汇总 ────────────────────────────────────────────────────
  const totalInvested = invested;
  const profit = finalValue - totalInvested;
  const totalReturn = totalInvested > 0 ? profit / totalInvested : 0;

  const flows = [];
  const flowMiList = [...flowByMi.keys()].sort((a, b) => a - b);
  for (let mi = flowMiList[0]; mi <= flowMiList[flowMiList.length - 1]; mi++) {
    if (flowByMi.has(mi)) flows.push(flowByMi.get(mi));
    else flows.push(0);
  }
  const years = (flowMiList[flowMiList.length - 1] - flowMiList[0] + 1) / 12;
  const annualized = irr(flows, 12);

  // 简单口径（不折现）用于展示对比
  const simpleAnnualized = years > 0 ? Math.pow(1 + totalReturn, 1 / years) - 1 : NaN;

  // 一次性买入对照：同样的总资金在首月月初一把梭
  const firstTrade = trades[0];
  const lumpShares = totalInvested / firstTrade.price;
  const lumpValue = lumpShares * priceEnd;
  const lumpReturn = totalInvested > 0 ? (lumpValue - totalInvested) / totalInvested : 0;

  // 全周期最大回撤（按市值/峰值）。只看定投期内 —— 定投结束后的持有期
  // 属于另一件事，混进"这次定投要忍受多大折磨"里会误导人。
  let peak = -Infinity;
  let maxDrawdown = 0;
  let maxDrawdownAt = null;
  for (const p of curve) {
    if (!p.inPeriod) break;
    if (p.value > peak) peak = p.value;
    if (peak > 0) {
      const dd = (peak - p.value) / peak;
      if (dd > maxDrawdown) {
        maxDrawdown = dd;
        maxDrawdownAt = p.month;
      }
    }
  }

  // 持仓浮亏最深的月份（账面亏损）
  let worstMi = null;
  let worstProfitRate = Infinity;
  let bestMi = null;
  let bestProfitRate = -Infinity;
  for (const p of curve) {
    if (!p.inPeriod || p.invested <= 0) continue;
    const r = (p.value - p.invested) / p.invested;
    if (r < worstProfitRate) { worstProfitRate = r; worstMi = p.month; }
    if (r > bestProfitRate) { bestProfitRate = r; bestMi = p.month; }
  }

  // 买入价的历史分位（越低越"抄底"）
  const allPrices = series.map((p) => p.price).sort((a, b) => a - b);
  const pctRank = (v) => {
    let lo = 0;
    let hi = allPrices.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (allPrices[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return allPrices.length > 1 ? lo / (allPrices.length - 1) : 0.5;
  };
  const avgBuyPrice = trades.reduce((s, t) => s + t.price * t.shares, 0) / (shares || 1);
  const avgBuyPercentile = pctRank(avgBuyPrice);
  const lstTradePrice = trades[trades.length - 1].price;

  // 价格位置：期末价在历史区间中的分位
  const endPercentile = pctRank(priceEnd);

  const startMiUsed2 = trades[0].mi;
  const calendarMonths = lastTradeMi - startMiUsed2 + 1;
  const calendarYears = calendarMonths / 12;

  // 各年度"当年赚了多少"（自然年）
  // 定义：某年度的账户累计盈亏 − 上一年度末的账户累计盈亏。
  // 不能直接用"年末市值 − 年末投入"，那样会把上一年已经赚到的钱重复计入。
  const yearly = [];
  const byYear = new Map();
  for (const p of curve) {
    const y = Math.floor(p.mi / 12);
    if (!byYear.has(y)) {
      byYear.set(y, { year: y, endInvested: p.invested, endValue: p.value, contributions: 0, cumProfitStart: null, days: 0 });
    }
    const rec = byYear.get(y);
    rec.endInvested = p.invested;
    rec.endValue = p.value;
    rec.days++;
  }
  for (const t of trades) {
    const y = Math.floor(t.mi / 12);
    const rec = byYear.get(y);
    if (rec) rec.contributions += t.amount;
  }
  const yearList = [...byYear.values()].sort((a, b) => a.year - b.year);
  let prevCumProfit = 0;
  for (const rec of yearList) {
    const cumProfit = rec.endValue - rec.endInvested;
    rec.cumProfit = cumProfit;
    rec.cumProfitStart = prevCumProfit;
    rec.profit = cumProfit - prevCumProfit; // 当年真正赚（亏）了多少
    rec.returnRate = rec.endInvested > 0 ? rec.profit / rec.endInvested : 0;
    prevCumProfit = cumProfit;
    yearly.push(rec);
  }

  // 市场区间涨幅（同期一次性持有该标的的涨幅）
  const marketReturn = lstTradePrice > 0 ? priceEnd / trades[0].price - 1 : 0;

  return {
    trades,
    curve,
    flows,
    summary: {
      startMonth: trades[0].month,
      endMonth: endBar.month,
      months: trades.length,
      calendarMonths,
      years: calendarYears,
      amount,
      monthlyAmount: amount,
      totalInvested,
      finalValue,
      finalShares: shares,
      idleCash,
      fees: feesSum,
      profit,
      totalReturn,
      annualized,
      simpleAnnualized,
      marketReturn,
      avgBuyPrice,
      avgBuyPercentile,
      endPrice: priceEnd,
      endPercentile,
      // 定投截止后继续持有到最新行情的参考市值（若截止月就是最新月，则与期末市值相同）
      holdMonth: holdBar.month,
      holdValue,
      holdProfit: holdValue - totalInvested,
      holdReturn: totalInvested > 0 ? (holdValue - totalInvested) / totalInvested : 0,
      lumpInvested: totalInvested,
      lumpValue,
      lumpProfit: lumpValue - totalInvested,
      lumpReturn,
      lumpAnnualized: calendarYears > 0 ? Math.pow(1 + lumpReturn, 1 / calendarYears) - 1 : NaN,
      maxDrawdown,
      maxDrawdownAt,
      worstMonth: worstMi,
      worstProfitRate: Number.isFinite(worstProfitRate) ? worstProfitRate : null,
      bestMonth: bestMi,
      bestProfitRate: Number.isFinite(bestProfitRate) ? bestProfitRate : null,
      missedMonths: missed,
      firstPrice: trades[0].price,
      lastPrice: lstTradePrice,
    },
    yearly,
    warnings,
  };
}

/** 便捷封装：根据股票记录 + 表单参数直接出结果 */
export function simulateFromParams(stock, params) {
  const series = normalizeSeries(stock.decodedSeries || []);
  const { startMonth, endMonth, amount, feeEnabled, feeRate, feeMin } = params;
  const sMi = monthIndex(startMonth);
  const eMi = monthIndex(endMonth);
  if (eMi < sMi) throw new Error('结束月份不能早于开始月份');
  // 期数 = 含首尾的月份数；若首月早于该标的上市月，则从上市首月起算
  const effectiveStart = Math.max(sMi, series[0].mi);
  const clampedEnd = Math.min(eMi, series[series.length - 1].mi);
  const months = clampedEnd - effectiveStart + 1;
  if (months < 1) throw new Error('所选区间与行情数据没有交集（该标的是否当时尚未上市？）');
  return simulate({
    series,
    startMonth: monthLabel(effectiveStart),
    months,
    amount,
    feeEnabled,
    feeRate,
    feeMin,
  });
}
