/**
 * 内置行情数据库的解码
 * ================================================================
 * 数据库里每条序列都是压缩过的（见 tools/build-db.mjs），格式说明：
 *
 *   1) 价格 prices：先算相邻月收盘价之差（单位「分」），
 *      再把整段差分平移成非负整数，平移量单独存在 seriesOffset；
 *   2) 时间轴 months：直接把每个月的「月序号」（年×12+月-1）编码成同一种整数序列，
 *      平移量存在 monthsOffset。之所以不省这点空间去只存"缺口"，
 *      是因为缺口表是稀疏的、解码时无法判断缺口落在哪两个相邻点之间，存在歧义；
 *      而停牌、长期停复牌在真实数据里很常见，时间轴必须能被无歧义地还原；
 *   3) 整数编码：按 7 bit 一组、低位组在前；除最后一组外都加 0x80 作"还有后续"标志，
 *      最后每个字节拆成两个 6 bit 字符（每个字符是 6 bit 的容器）。
 *
 * 这个模块是浏览器端唯一的解码入口，与构建脚本严格对称；
 * 任何对不上的地方都直接抛错，而不是悄悄给出一个错的数字。
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const ALPHA_IDX = (() => {
  const m = new Map();
  for (let i = 0; i < ALPHABET.length; i++) m.set(ALPHABET[i], i);
  return m;
})();

/** 紧凑字符串 -> 整数数组（与 tools/build-db.mjs 的 encodeInts 严格对称） */
export function decodeInts(str, offset = 0) {
  const out = [];
  if (!str) return out;
  if (str.length % 2 !== 0) throw new Error('价格数据损坏：字符个数应为偶数');

  // 第一步：两个字符还原一个字节（高 6 位 + 低 6 位）
  const bytes = [];
  for (let i = 0; i < str.length; i += 2) {
    const hi = ALPHA_IDX.get(str[i]);
    const lo = ALPHA_IDX.get(str[i + 1]);
    if (hi === undefined || lo === undefined) {
      throw new Error(`价格数据损坏：出现非法字符 "${str[i]}${str[i + 1]}"`);
    }
    bytes.push(hi * 64 + lo);
  }

  // 第二步：字节流按 7 bit 一组读回整数，bit 7 是"后面还有"标志
  let i = 0;
  while (i < bytes.length) {
    let shift = 1;
    let val = 0;
    for (;;) {
      if (i >= bytes.length) throw new Error('价格数据损坏：变长整数被截断');
      const b = bytes[i++];
      val += (b % 128) * shift;
      if (b < 128) break;
      shift *= 128;
    }
    out.push(val + offset);
  }
  return out;
}

/** 差分序列 -> 价格数组（单位：元） */
export function decodeSeries(str, offset = 0, scale = 100) {
  const deltas = decodeInts(str, offset);
  let acc = 0;
  const ints = deltas.map((d) => (acc += d));
  return ints.map((v) => v / scale);
}

/** 月序号序列 -> 'YYYY-MM' 数组 */
export function decodeMonths(str, offset = 0) {
  return decodeInts(str, offset).map((mi) => `${Math.floor(mi / 12)}-${String((mi % 12) + 1).padStart(2, '0')}`);
}

/**
 * 把数据库里的一条标的记录展开成 { month, close } 序列。
 * @param {object} rec 数据库中的 stock 记录
 * @param {number} scale 价格精度（分）
 */
export function decodeStockRecord(rec, scale = 100) {
  const rawSeries = String(rec.series || '').replace('___ENCODED___', '');
  const prices = decodeSeries(rawSeries, rec.seriesOffset || 0, scale);
  const months = decodeMonths(rec.months, rec.monthsOffset || 0);

  // 自检：展开结果必须与元信息完全一致，否则说明数据损坏。
  // 宁可报错，也不要拿一个错的价格去算收益。
  if (prices.length !== months.length) {
    throw new Error(`${rec.name}(${rec.code}) 价格与月份数量不一致：${prices.length} vs ${months.length}`);
  }
  if (rec.span && prices.length !== rec.span) {
    throw new Error(`${rec.name}(${rec.code}) 点位数量与元信息不一致：${prices.length} ≠ ${rec.span}`);
  }
  if (months[0] !== rec.first) {
    throw new Error(`${rec.name}(${rec.code}) 起始月份不一致：${months[0]} ≠ ${rec.first}`);
  }
  if (rec.last && months[months.length - 1] !== rec.last) {
    throw new Error(`${rec.name}(${rec.code}) 末月不一致：${months[months.length - 1]} ≠ ${rec.last}`);
  }
  for (let i = 1; i < months.length; i++) {
    if (!(months[i] > months[i - 1])) {
      throw new Error(`${rec.name}(${rec.code}) 月份未严格递增：${months[i - 1]} -> ${months[i]}`);
    }
  }
  if (prices.some((p) => !(p > 0))) {
    throw new Error(`${rec.name}(${rec.code}) 出现非正价格，后复权序列理应恒为正`);
  }

  return prices.map((close, i) => ({ month: months[i], close }));
}
