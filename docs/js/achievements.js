/**
 * 称号与成就系统
 * ================================================================
 * 设计原则：
 *   1. 定档看「年化收益率（IRR）」—— 定投是分批投入的，只看总收益率会被时间
 *      长度严重扭曲（同样 +100%，2 年就是神，8 年就很平庸）；
 *   2. 总收益率参与同档内的微调，避免"长期慢牛"被低估；
 *   3. 成就分三层：收益勋章（跟钱走）、行为勋章（跟纪律走）、彩蛋勋章（跟故事走）。
 */

/** 主称号阶梯：按年化收益率（小数）从高到低匹配第一档 */
export const RANKS = [
  {
    key: 'god',
    min: 0.40,
    title: '吧菲特附体',
    emoji: '👑',
    quote: '“别人恐惧我贪婪”——你说这话的时候，市场确实在恐惧。',
    desc: '年化 ≥ 40%：这是长期年化，不是某一年。请立刻检查是不是看错了年限。',
    tone: 'god',
  },
  {
    key: 'master',
    min: 0.25,
    title: 'A股扫地僧',
    emoji: '🧘',
    quote: '不追热点，不看盘，账户替我修行。',
    desc: '年化 25%~40%：长期跑赢绝大多数公募，可以开始接受亲友咨询了。',
    tone: 'great',
  },
  {
    key: 'grader',
    min: 0.15,
    title: '价投及格生',
    emoji: '🎓',
    quote: '巴菲特说年化 20% 就很好了，你还差一点，但已经在正确的路上。',
    desc: '年化 15%~25%：长期复利机器已启动，剩下的交给时间。',
    tone: 'great',
  },
  {
    key: 'winner',
    min: 0.08,
    title: '稳健小赚人',
    emoji: '📈',
    quote: '跑赢通胀，跑赢理财，晚上睡得着觉。',
    desc: '年化 8%~15%：很体面的成绩，多数人一辈子都摸不到这条线。',
    tone: 'good',
  },
  {
    key: 'flat',
    min: 0.02,
    title: '平庸但没亏',
    emoji: '😐',
    quote: '不亏就是赢，心态已经赢了。',
    desc: '年化 2%~8%：略胜货基，输给通胀，属于"参与感很足"。',
    tone: 'meh',
  },
  {
    key: 'breakeven',
    min: -0.02,
    title: '陪跑运动员',
    emoji: '🏃',
    quote: '重在参与，账户只是陪我跑步的。',
    desc: '年化 -2%~2%：白忙一场，但至少没给市场交学费。',
    tone: 'meh',
  },
  {
    key: 'leek',
    min: -0.10,
    title: '初级韭菜',
    emoji: '🌱',
    quote: '韭菜的自我修养第一课：绿是主色调。',
    desc: '年化 -10%~-2%：小额亏损，属于市场的"体验课"。',
    tone: 'bad',
  },
  {
    key: 'midleek',
    min: -0.20,
    title: '资深韭菜',
    emoji: '🥬',
    quote: '割了一茬又一茬，根还在土里。',
    desc: '年化 -20%~-10%：已经开始理解"价值投资"四个字的重量。',
    tone: 'bad',
  },
  {
    key: 'leekking',
    min: -0.35,
    title: '韭菜中的韭菜',
    emoji: '🥬🥬',
    quote: '你不是在亏钱，你是在给市场做流动性贡献。',
    desc: '年化 -35%~-20%：长期做到这个水平的难度，其实不低于年化 35%。',
    tone: 'awful',
  },
  {
    key: 'rooftop',
    min: -0.55,
    title: '天台吹风人',
    emoji: '🌬️',
    quote: '风很大，但账户更凉。',
    desc: '年化 -55%~-35%：请务必先关掉交易软件，再去看一眼窗外的天气。',
    tone: 'awful',
  },
  {
    key: 'abyss',
    min: -Infinity,
    title: '销户跑路预备役',
    emoji: '🕳️',
    quote: '销户是不可能销户的，只是把 App 藏进了文件夹第 7 页。',
    desc: '年化 < -55%：这种成绩需要天赋，建议从此只买货基。',
    tone: 'abyss',
  },
];

/** 按年化收益率定档；并允许总收益率在边界处做一次向上取整（长期慢牛优待） */
export function pickRank(annualized, totalReturn, years) {
  const total = Number.isFinite(totalReturn) ? totalReturn : 0;

  // 年化算不出来时（理论上不该发生，但必须兜底），
  // 用总收益率估一个等效年化，而不是一律退回"平庸但没亏" ——
  // 那会让一个亏掉 90% 的账户拿到中性称号，属于自相矛盾的展示。
  let rate = annualized;
  let reason = null;
  if (!Number.isFinite(rate)) {
    if (!Number.isFinite(years) || years <= 0) {
      rate = total;
      reason = '期限不足一年，改用总收益率定档';
    } else if (total <= -1) {
      rate = -1;
      reason = '本金几乎全部亏损，按最差档处理';
    } else {
      rate = Math.pow(1 + total, 1 / years) - 1;
      reason = '年化收益率无解，改用总收益率折算';
    }
  }

  let idx = RANKS.findIndex((r) => rate >= r.min);
  if (idx === -1) idx = RANKS.length - 1;
  // 长期（≥8 年）且总收益率为正时，若年化只是"擦着"上一档的门槛（差 0.5 个百分点以内），
  // 就给一次升档照顾 —— 长期正收益本身就该被奖励。
  if (years >= 8 && total > 0 && idx > 0) {
    const higher = RANKS[idx - 1];
    if (rate >= higher.min - 0.005) idx -= 1;
  }
  const rank = RANKS[idx];
  return reason ? { ...rank, reason } : rank;
}

/**
 * 成就定义表。
 * 每个成就的 test(ctx) 返回 boolean，ctx 为 simulate() 的结果 + 元信息。
 */
export const ACHIEVEMENTS = [
  // ── 收益勋章 ─────────────────────────────────────────────
  {
    id: 'profit_double',
    emoji: '💰',
    name: '翻倍俱乐部',
    desc: '定投总收益率 ≥ 100%',
    rarity: 'rare',
    test: (c) => c.summary.totalReturn >= 1,
  },
  {
    id: 'profit_triple',
    emoji: '💎',
    name: '三倍收割机',
    desc: '定投总收益率 ≥ 200%',
    rarity: 'epic',
    test: (c) => c.summary.totalReturn >= 2,
  },
  {
    id: 'profit_five',
    emoji: '🏔️',
    name: '五倍传说',
    desc: '定投总收益率 ≥ 400%',
    rarity: 'legend',
    test: (c) => c.summary.totalReturn >= 4,
  },
  {
    id: 'loss_half',
    emoji: '🩸',
    name: '腰斩体验官',
    desc: '定投总收益率 ≤ -50%',
    rarity: 'rare',
    test: (c) => c.summary.totalReturn <= -0.5,
  },
  {
    id: 'loss_quarter',
    emoji: '🥲',
    name: '绿色环保大使',
    desc: '定投总收益率 ≤ -25%',
    rarity: 'common',
    test: (c) => c.summary.totalReturn <= -0.25,
  },
  {
    id: 'best_dca',
    emoji: '🥊',
    name: '我战胜了巴菲特',
    desc: '同期定投跑赢"一把梭"至少 15 个百分点',
    rarity: 'epic',
    test: (c) => c.summary.totalReturn - c.summary.lumpReturn >= 0.15,
  },
  {
    id: 'worst_dca',
    emoji: '🤦',
    name: '我打不过一把梭',
    desc: '同期"一把梭"比定投高出 15 个百分点以上',
    rarity: 'common',
    test: (c) => c.summary.lumpReturn - c.summary.totalReturn >= 0.15,
  },

  // ── 行为勋章 ─────────────────────────────────────────────
  {
    id: 'ten_years',
    emoji: '🪨',
    name: 'A股钉子户',
    desc: '连续定投满 10 年',
    rarity: 'epic',
    test: (c) => c.summary.months >= 120,
  },
  {
    id: 'five_years',
    emoji: '🗿',
    name: '长期主义者',
    desc: '连续定投满 5 年',
    rarity: 'rare',
    test: (c) => c.summary.months >= 60,
  },
  {
    id: 'diamond_hands',
    emoji: '🙌',
    name: '钻石手',
    desc: '经历最大回撤 ≥ 40% 仍未放弃',
    rarity: 'epic',
    // 注意：最大回撤在 summary 里，不是 ctx 顶层。
    // 这里曾写成 c.maxDrawdown（永远 undefined），导致这枚徽章永远解锁不了，
    // 而当时的测试夹具在顶层也塞了一份 maxDrawdown，正好把它掩盖了。
    test: (c) => c.summary.maxDrawdown >= 0.4 && c.summary.months >= 24,
  },
  {
    id: 'steel_heart',
    emoji: '🫀',
    name: '心态大师',
    desc: '账面浮亏曾超过 -40%，最终仍正收益',
    rarity: 'legend',
    test: (c) => c.summary.worstProfitRate != null && c.summary.worstProfitRate <= -0.4 && c.summary.profit > 0,
  },
  {
    id: 'buy_low',
    emoji: '🎯',
    name: '精准抄底',
    desc: '平均买入价处于历史价格最低 20% 区间',
    rarity: 'epic',
    // 必须真的买到过东西：零持股时 avgBuyPrice 会被兜底成 0，
    // 而 0 的分位数天然是 0%（历史最低），会误判成"完美抄底"。
    test: (c) => c.summary.finalShares > 0 && c.summary.avgBuyPercentile <= 0.2,
  },
  {
    id: 'buy_high',
    emoji: '🔪',
    name: '高位接盘侠',
    desc: '平均买入价处于历史价格最高的 20% 区间',
    rarity: 'rare',
    test: (c) => c.summary.finalShares > 0 && c.summary.avgBuyPercentile >= 0.8,
  },
  {
    id: 'tithe',
    emoji: '🪙',
    name: '十万大洋',
    desc: '累计投入 ≥ 10 万元',
    rarity: 'common',
    test: (c) => c.summary.totalInvested >= 100000,
  },
  {
    id: 'whale',
    emoji: '🐋',
    name: '百万实盘',
    desc: '累计投入 ≥ 100 万元',
    rarity: 'rare',
    test: (c) => c.summary.totalInvested >= 1000000,
  },
  {
    id: 'no_fee',
    emoji: '🧾',
    name: '零成本搬运工',
    desc: '开启手续费后依然正收益',
    rarity: 'common',
    test: (c) => c.feeEnabled && c.summary.profit > 0,
  },
  {
    id: 'profit_at_close',
    emoji: '🌳',
    name: '分红养我',
    desc: '越跌越买，最终收益超过同期股价涨幅',
    rarity: 'rare',
    test: (c) => c.summary.totalReturn > c.summary.marketReturn && c.summary.marketReturn < 0.2 && c.summary.months >= 36,
  },

  // ── 彩蛋勋章 ─────────────────────────────────────────────
  {
    id: 'moutai_2013',
    emoji: '🍶',
    name: '塑化剂里捡茅台',
    desc: '在 2013 年白酒塑化剂危机期间买入茅台',
    rarity: 'legend',
    test: (c) => c.stockCode === '600519' && c.tradesTouched(c.startYearMonth('2012-11'), c.startYearMonth('2014-01')),
  },
  {
    id: 'csi_2015_top',
    emoji: '⛰️',
    name: '2015 山顶点灯人',
    desc: '在 2015 年 5-6 月大牛市的最高点附近开始定投',
    rarity: 'epic',
    test: (c) => c.tradesTouched(c.startYearMonth('2015-04'), c.startYearMonth('2015-07')),
  },
  {
    id: 'crash_2024_09',
    emoji: '🚀',
    name: '924 行情亲历者',
    desc: '在 2024 年 9 月的史诗级反弹中持有仓位',
    rarity: 'rare',
    test: (c) => c.tradesTouched(c.startYearMonth('2024-08'), c.startYearMonth('2025-01')),
  },
  {
    id: 'crash_2008',
    emoji: '🧊',
    name: '2008 冰河世纪幸存者',
    desc: '在 2008 年金融危机期间坚持定投',
    rarity: 'legend',
    test: (c) => c.tradesTouched(c.startYearMonth('2008-06'), c.startYearMonth('2009-03')),
  },
  {
    id: 'cov_2020',
    emoji: '😷',
    name: '新冠底逆行者',
    desc: '在 2020 年 2-4 月疫情底附近买入',
    rarity: 'epic',
    test: (c) => c.tradesTouched(c.startYearMonth('2020-02'), c.startYearMonth('2020-05')),
  },
  {
    id: 'crash_2022',
    emoji: '🌧️',
    name: '2022 熊市打卡人',
    desc: '在 2022 年全年阴跌中坚持定投',
    rarity: 'common',
    test: (c) => c.tradesTouched(c.startYearMonth('2022-03'), c.startYearMonth('2022-11')),
  },
  {
    id: 'fee_eater',
    emoji: '🧾',
    name: '养活了券商',
    desc: '累计手续费 ≥ 200 元，且总收益仍为正',
    rarity: 'common',
    // 原来的判据是"账户闲置零钱 ≥200 元"。但定投允许零股买入，
    // 每期只会剩下浮点残差（实测全库最大 2.9e-10），这枚徽章根本解锁不了。
    // 换成同样"小钱"含义、但真实会累积的手续费。
    test: (c) => c.summary.fees >= 200 && c.summary.profit > 0,
  },
  {
    id: 'index_500_bull',
    emoji: '🐂',
    name: '牛市旗手本人',
    desc: '定投券商类标的并取得 50% 以上收益',
    rarity: 'rare',
    test: (c) => /券商|证券/.test(c.stockName) && c.summary.totalReturn >= 0.5,
  },
  {
    id: 'oil_forever',
    emoji: '🛢️',
    name: '问君能有几多愁',
    desc: '定投中国石油并最终盈利',
    rarity: 'legend',
    test: (c) => c.stockCode === '601857' && c.summary.profit > 0,
  },
  {
    id: 'etf_forever',
    emoji: '🧺',
    name: '定投教科书',
    desc: '定投宽基 ETF 满 5 年',
    rarity: 'common',
    test: (c) => /ETF/.test(c.stockName) && c.summary.months >= 60,
  },
  {
    id: 'beats_index',
    emoji: '🏁',
    name: '跑赢沪深300',
    desc: '年化跑赢同期沪深300ETF 至少 5 个百分点',
    rarity: 'rare',
    needsBenchmark: true,
    test: (c) => Number.isFinite(c.benchmarkAnnualized) && c.summary.annualized - c.benchmarkAnnualized >= 0.05,
  },
  {
    id: 'lag_index',
    emoji: '🐢',
    name: '还不如买指数',
    desc: '年化落后同期沪深300ETF 至少 5 个百分点',
    rarity: 'common',
    needsBenchmark: true,
    test: (c) => Number.isFinite(c.benchmarkAnnualized) && c.benchmarkAnnualized - c.summary.annualized >= 0.05,
  },
  {
    id: 'same_start',
    emoji: '🕰️',
    name: '一投到底',
    desc: '从该标的有数据的第一年开始定投',
    rarity: 'epic',
    test: (c) => c.summary.startMonth === c.stockFirstMonth,
  },
];

/**
 * 评估所有成就。
 * @param {object} ctx 见 buildContext()
 * @returns {{unlocked: object[], locked: object[], score: number}}
 */
export function evaluateAchievements(ctx) {
  const unlocked = [];
  const locked = [];
  for (const a of ACHIEVEMENTS) {
    if (a.needsBenchmark && !ctx.hasBenchmark) {
      locked.push({ ...a, lockedReason: '需要沪深300对比数据' });
      continue;
    }
    let ok = false;
    try {
      ok = !!a.test(ctx);
    } catch {
      ok = false;
    }
    if (ok) unlocked.push(a);
    else locked.push(a);
  }
  const weight = { common: 1, rare: 3, epic: 6, legend: 10 };
  const score = unlocked.reduce((s, a) => s + (weight[a.rarity] || 1), 0);
  return { unlocked, locked, score };
}

/** 根据跑分给一个"成就等级"，纯玩梗 */
export function achievementGrade(score) {
  if (score >= 45) return { label: '🏆 白金成就猎人', desc: '你把这个模拟器玩穿了' };
  if (score >= 30) return { label: '🥇 黄金成就猎人', desc: '对 A 股的历史如数家珍' };
  if (score >= 18) return { label: '🥈 白银成就猎人', desc: '认真研究过几轮牛熊' };
  if (score >= 8) return { label: '🥉 青铜成就猎人', desc: '已经开始上道了' };
  if (score >= 1) return { label: '🎈 成就新人', desc: '刚解锁第一个徽章' };
  return { label: '🫥 无成就', desc: '还没点亮任何徽章，换个参数试试' };
}

/** 成就总数与稀有度分布，供页面/文档展示，避免各处手写数字不同步 */
export function achievementStats() {
  const byRarity = { common: 0, rare: 0, epic: 0, legend: 0 };
  for (const a of ACHIEVEMENTS) byRarity[a.rarity] = (byRarity[a.rarity] || 0) + 1;
  return { total: ACHIEVEMENTS.length, ranks: RANKS.length, byRarity };
}
