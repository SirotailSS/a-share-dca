/**
 * 零依赖 SVG 折线图
 * ================================================================
 * 为什么不用 ECharts / Chart.js：
 *   · 页面要能直接 file:// 双击打开，也要能在 GitHub Pages 上离线可用，
 *     所以不引任何 CDN；
 *   · 只画三条线 + 一条渐变面积，原生 SVG 代码不到 200 行，体积 0 KB 依赖。
 */

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

const fmtAmount = (v) => {
  const abs = Math.abs(v);
  if (abs >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
  if (abs >= 1e4) return (v / 1e4).toFixed(1) + ' 万';
  return Math.round(v).toLocaleString('zh-CN');
};

/** 生成一个"好看"的坐标轴刻度步长 */
function niceStep(range, targetTicks) {
  if (range <= 0) return 1;
  const rough = range / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  let step;
  if (norm <= 1) step = 1;
  else if (norm <= 2) step = 2;
  else if (norm <= 2.5) step = 2.5;
  else if (norm <= 5) step = 5;
  else step = 10;
  return step * mag;
}

/**
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {{month:string, invested:number, value:number}[]} opts.curve
 * @param {{label:string, month:string}[]} [opts.markers] 事件标记
 */
export function createChart(container, opts) {
  const W = 1000;
  const H = 400;
  const PAD = { top: 22, right: 18, bottom: 34, left: 74 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  container.innerHTML = '';
  const curve = opts.curve || [];
  if (curve.length < 2) {
    const empty = document.createElement('div');
    empty.className = 'chart-empty';
    empty.textContent = '区间太短，画不出曲线（至少需要 2 个月数据）';
    container.appendChild(empty);
    return { destroy() {} };
  }

  const values = curve.flatMap((p) => [p.value, p.invested]);
  let vMin = Math.min(0, ...values);
  let vMax = Math.max(...values);
  if (vMax === vMin) vMax = vMin + 1;
  const step = niceStep(vMax - vMin, 4);
  vMin = Math.floor(vMin / step) * step;
  vMax = Math.ceil(vMax / step) * step;

  const n = curve.length;
  const X = (i) => PAD.left + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const Y = (v) => PAD.top + innerH - ((v - vMin) / (vMax - vMin)) * innerH;

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'none',
    class: 'chart-svg',
    role: 'img',
    'aria-label': '累计投入与账户市值曲线',
  });
  const defs = el('defs');
  const gradFill = el('linearGradient', { id: 'valueFill', x1: '0', y1: '0', x2: '0', y2: '1' });
  gradFill.append(
    el('stop', { offset: '0%', 'stop-color': 'var(--accent)', 'stop-opacity': '0.34' }),
    el('stop', { offset: '100%', 'stop-color': 'var(--accent)', 'stop-opacity': '0.02' })
  );
  const gradStroke = el('linearGradient', { id: 'valueStroke', x1: '0', y1: '0', x2: '1', y2: '0' });
  gradStroke.append(
    el('stop', { offset: '0%', 'stop-color': 'var(--accent)' }),
    el('stop', { offset: '100%', 'stop-color': 'var(--accent-2)' })
  );
  defs.append(gradFill, gradStroke);
  svg.appendChild(defs);

  // ── 网格 + Y 轴刻度 ───────────────────────────────────────
  const gGrid = el('g', { class: 'grid' });
  for (let v = vMin; v <= vMax + step / 2; v += step) {
    const y = Y(v);
    gGrid.appendChild(el('line', { x1: PAD.left, y1: y, x2: W - PAD.right, y2: y, class: 'grid-line' }));
    const label = el('text', { x: PAD.left - 10, y: y + 4, class: 'axis-label', 'text-anchor': 'end' });
    label.textContent = fmtAmount(v);
    gGrid.appendChild(label);
  }
  svg.appendChild(gGrid);

  // ── X 轴刻度（按年份） ────────────────────────────────────
  const gX = el('g', { class: 'axis-x' });
  const seenYears = new Set();
  const yearSpan = Math.max(1, Math.floor(n / 12) + 1);
  const yearStep = yearSpan <= 3 ? 1 : yearSpan <= 8 ? 2 : yearSpan <= 16 ? 3 : 5;
  curve.forEach((p, i) => {
    const year = Number(p.month.slice(0, 4));
    if (seenYears.has(year) || (year % yearStep !== 0 && i !== 0)) return;
    seenYears.add(year);
    const t = el('text', { x: X(i), y: H - 12, class: 'axis-label', 'text-anchor': 'middle' });
    t.textContent = year;
    gX.appendChild(t);
    gX.appendChild(el('line', { x1: X(i), y1: PAD.top, x2: X(i), y2: PAD.top + innerH, class: 'grid-line grid-line-v' }));
  });
  svg.appendChild(gX);

  // ── 曲线路径 ─────────────────────────────────────────────
  const line = (key) => {
    let d = '';
    curve.forEach((p, i) => {
      d += `${i === 0 ? 'M' : 'L'}${X(i).toFixed(2)},${Y(p[key]).toFixed(2)}`;
    });
    return d;
  };

  const investedPath = el('path', { d: line('invested'), class: 'line line-invested' });
  const areaPath = el('path', {
    d: `${line('value')}L${X(n - 1).toFixed(2)},${Y(Math.max(vMin, 0))}L${X(0).toFixed(2)},${Y(Math.max(vMin, 0))}Z`,
    class: 'area-value',
    fill: 'url(#valueFill)',
  });
  const valuePath = el('path', { d: line('value'), class: 'line line-value', stroke: 'url(#valueStroke)' });
  svg.appendChild(areaPath);
  svg.appendChild(investedPath);
  svg.appendChild(valuePath);

  // ── 事件标记 ─────────────────────────────────────────────
  const monthToIndex = new Map(curve.map((p, i) => [p.month, i]));
  if (Array.isArray(opts.markers)) {
    for (const m of opts.markers) {
      const idx = monthToIndex.get(m.month);
      if (idx == null) continue;
      const x = X(idx);
      svg.appendChild(el('line', { x1: x, y1: PAD.top, x2: x, y2: PAD.top + innerH, class: 'marker-line' }));
      const t = el('text', { x, y: PAD.top - 8, class: 'marker-label', 'text-anchor': 'middle' });
      t.textContent = m.label;
      svg.appendChild(t);
    }
  }

  // ── 十字光标 ─────────────────────────────────────────────
  const gHover = el('g', { class: 'hover', style: 'display:none' });
  const vLine = el('line', { y1: PAD.top, y2: PAD.top + innerH, class: 'hover-line' });
  const dotValue = el('circle', { r: 5, class: 'hover-dot hover-dot-value' });
  const dotInvested = el('circle', { r: 4, class: 'hover-dot hover-dot-invested' });
  gHover.append(vLine, dotValue, dotInvested);
  svg.appendChild(gHover);

  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.style.display = 'none';

  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  wrap.append(svg, tip);
  container.appendChild(wrap);

  const onMove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
    const relX = ((clientX - rect.left) / rect.width) * W;
    const ratio = (relX - PAD.left) / innerW;
    let i = Math.round(ratio * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    const p = curve[i];
    const x = X(i);
    gHover.style.display = '';
    vLine.setAttribute('x1', x);
    vLine.setAttribute('x2', x);
    dotValue.setAttribute('cx', x);
    dotValue.setAttribute('cy', Y(p.value));
    dotInvested.setAttribute('cx', x);
    dotInvested.setAttribute('cy', Y(p.invested));

    const profit = p.value - p.invested;
    const rate = p.invested > 0 ? profit / p.invested : 0;
    tip.innerHTML =
      `<b>${p.month}</b>` +
      `<span>累计投入 ${fmtAmount(p.invested)}</span>` +
      `<span>账户市值 ${fmtAmount(p.value)}</span>` +
      `<span class="${profit >= 0 ? 'up' : 'down'}">浮动盈亏 ${profit >= 0 ? '+' : ''}${fmtAmount(profit)}（${(rate * 100).toFixed(1)}%）</span>`;
    tip.style.display = '';
    const leftPx = (x / W) * rect.width;
    tip.style.left = `${Math.max(8, Math.min(rect.width - tip.offsetWidth - 8, leftPx - tip.offsetWidth / 2))}px`;
    tip.style.top = `${Math.max(4, (Y(Math.max(p.value, p.invested)) / H) * rect.height - tip.offsetHeight - 12)}px`;
  };
  const onLeave = () => {
    gHover.style.display = 'none';
    tip.style.display = 'none';
  };
  svg.addEventListener('mousemove', onMove);
  svg.addEventListener('mouseleave', onLeave);
  svg.addEventListener('touchstart', onMove, { passive: true });
  svg.addEventListener('touchmove', onMove, { passive: true });
  svg.addEventListener('touchend', onLeave);

  return {
    destroy() {
      svg.removeEventListener('mousemove', onMove);
      svg.removeEventListener('mouseleave', onLeave);
      container.innerHTML = '';
    },
  };
}

/** 迷你柱状图：年度盈亏 */
export function createYearBars(container, yearly) {
  container.innerHTML = '';
  if (!Array.isArray(yearly) || yearly.length === 0) return;
  const max = Math.max(...yearly.map((y) => Math.abs(y.profit)), 1);
  const frag = document.createDocumentFragment();
  for (const y of yearly) {
    const item = document.createElement('div');
    item.className = 'year-item';
    const pct = (Math.abs(y.profit) / max) * 100;
    const up = y.profit >= 0;
    item.innerHTML =
      `<div class="year-bar-track"><div class="year-bar ${up ? 'up' : 'down'}" style="height:${Math.max(2, pct)}%"></div></div>` +
      `<div class="year-label">${String(y.year).slice(2)}</div>` +
      `<div class="year-value ${up ? 'up' : 'down'}">${up ? '+' : ''}${(y.profit / 10000).toFixed(1)}万</div>`;
    item.title = `${y.year} 年：累计投入 ${fmtAmount(y.endInvested)}，年末市值 ${fmtAmount(y.endValue)}，盈亏 ${y.profit >= 0 ? '+' : ''}${fmtAmount(y.profit)}（${(y.returnRate * 100).toFixed(1)}%）`;
    frag.appendChild(item);
  }
  container.appendChild(frag);
}

export { fmtAmount };
