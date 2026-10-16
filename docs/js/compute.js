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
 * 数值细节（都踩过坑，别改回去）：
 *   · 不用 NPV(r) = Σ cf_i / (1+r)^i 直接算。当 r 接近 -1 时 (1+r)^i 会下溢成 0，
 *     远端现金流除零就变成 Infinity/NaN，二分会静默返回 NaN。
 *     改用霍纳形式：NPV(r) · (1+r)^(n-1) = Σ cf_i · (1+r)^(n-1-i)，右边是普通多项式，
 *     在 [-1, 0) 上完全良态；NPV 的符号与它一致，二分只需要符号。
 *   · 初始区间 [-0.5, 1]（月率），没夹住根时向两侧放宽：
 *     下界朝 -1 逼近（lo = -1 + (1+lo)/4），上界乘 4。
 *     ⚠️ 这里的方向曾经写反（下界往上抬），导致"期末变现额 < 约 2×月供"的
 *     极端亏损永远返回 NaN —— 那正是最该给出答案的情形。
 *   · 真的夹不住时（例如 -100% 亏损这种退化情形）兜底到 -1（年化 -100%），
 *     而不是 NaN：NaN 会让页面显示"—"并让称号系统退回默认档，属于静默错误。
 *
 * @param {number[]} flows 现金流数组，flows[0] 为 t=0 时刻
 * @param {number} periodsPerYear 每年期数（月度=12）
 * @returns {number} 年化收益率（小数，0.15 = 15%）
 */
export function irr(flows, periodsPerYear = 12) {
  const n = flows.length;
  if (n === 0) return NaN;

  // 退化情形：整个区间的净现金流恒为 0 —— 典型是"起止同月"，
  // 当月买入即按同一收盘价估价，投入与变现完全相抵。
  // 此时收益率恰好是 0，而不是"无解"；返回 NaN 会让页面显示"—"、称号也退化。
  // ⚠️ 这一判断必须放在"只有投入/只有回收"两个提前返回之前，
  // 因为长度为 1 且值为 0 的数组同时满足那两个条件。
  if (flows.every((f) => f === 0)) return 0;

  const hasNegative = flows.some((f) => f < 0);
  const positiveSum = flows.reduce((s, f) => (f > 0 ? s + f : s), 0);
  const negativeSum = flows.reduce((s, f) => (f < 0 ? s + f : s), 0);

  // 只有投入、没有任何回收：这是"全损"，年化就是 -100%。
  // 不能返回 NaN —— 页面会显示"—"、称号系统会退回默认档，属于静默错误。
  if (hasNegative && positiveSum === 0) return -1;
  // 有投入也有回收才可能有内部收益率
  if (!hasNegative || positiveSum <= 0) return NaN;

  const annualize = (rate) => Math.pow(1 + rate, periodsPerYear) - 1;
  const MIN_RATE = -1 + 1e-9;

  // 霍纳法：p(r) = Σ cf_i · (1+r)^(n-1-i)，与 NPV(r)·(1+r)^(n-1) 同号
  const poly = (r) => {
    const x = 1 + r;
    let acc = 0;
    for (let i = 0; i < n; i++) acc = acc * x + flows[i];
    return acc;
  };
  const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

  let lo = -0.5;
  let hi = 1;
  let slo = sign(poly(lo));
  let shi = sign(poly(hi));

  if (slo === 0) return annualize(lo);
  if (shi === 0) return annualize(hi);

  // 向两侧放宽，直到把根夹住
  for (let guard = 0; guard < 120 && slo === shi; guard++) {
    if (hi < 1e4) {
      hi *= 4;
      shi = sign(poly(hi));
      if (shi === 0) return annualize(hi);
    }
    if (lo > MIN_RATE) {
      lo = -1 + (1 + lo) / 4;
      if (lo < MIN_RATE) lo = MIN_RATE;
      slo = sign(poly(lo));
      if (slo === 0) return annualize(lo);
    }
  }

  // 夹不住：说明这个现金流在数值意义上退化。
  // 按最后一段的净额方向给出合理的极端值，而不是 NaN。
  if (slo === shi) {
    // 总回收 < 总投入 → 亏损到接近 -100%；反之则收益极大
    return positiveSum + negativeSum <= 0 ? -1 : annualize(hi);
  }

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const smid = sign(poly(mid));
    if (smid === 0) return annualize(mid);
    if (smid === slo) { lo = mid; slo = smid; } else { hi = mid; }
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
  // ⚠️ annualized 必须在 flows 构造完成之后再算。
  // 这里曾经写在 return 的对象字面量里，而 flows 是在其下方才声明的，
  // 属于暂时性死区（TDZ）：一进入 compute 就抛 ReferenceError，
  // 被上层 catch 吞掉后页面显示的是"上一轮结果"，极难排查。
  const annualized = irr(flows, 12);

  // 简单口径（不折现）用于展示对比
  const simpleAnnualized = years > 0 ? Math.pow(1 + totalReturn, 1 / years) - 1 : NaN;

  // 一次性买入对照：把"同样多的总资金"在首月一次买入。
  // 为了让两者可比，这里也用同一套手续费规则处理这笔一次性买入：
  // 否则开了手续费的定投会被白白多扣一笔钱，对比就不公平（小额时能差好几个百分点）。
  const firstTrade = trades[0];
  let lumpFee = 0;
  if (feeEnabled) lumpFee = Math.max(feeMin, totalInvested * feeRate);
  const lumpShares = (totalInvested - lumpFee) / firstTrade.price;
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
