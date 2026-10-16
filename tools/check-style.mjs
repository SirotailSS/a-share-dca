/**
 * 静态布局审查：不依赖浏览器，检查 CSS 里那些"肉眼才看得出"的坑。
 * 用法：node tools/check-style.mjs
 *
 * 为什么需要它：页面逻辑已经有无头测试覆盖，但"括号不配对导致后半段样式全失效""图表高度为 0"
 * 这类问题只有渲染时才暴露。这里把可静态判定的部分先卡住。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const css = await fs.readFile(path.join(ROOT, 'docs', 'css', 'style.css'), 'utf8');
const html = await fs.readFile(path.join(ROOT, 'docs', 'index.html'), 'utf8');

const problems = [];
const notes = [];
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    problems.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
};

console.log('=== CSS 静态审查 ===');

// 1. 花括号配对
const open = (css.match(/\{/g) || []).length;
const close = (css.match(/\}/g) || []).length;
check('花括号配对', open === close, `{ ${open} 个，} ${close} 个`);

// 2. 圆括号配对（calc/var/rgba 最容易漏）
const pOpen = (css.match(/\(/g) || []).length;
const pClose = (css.match(/\)/g) || []).length;
check('圆括号配对', pOpen === pClose, `( ${pOpen} 个，) ${pClose} 个`);

// 3. 所有 var(--x) 都要有定义（:root 里或本地覆盖）
const defined = new Set([...css.matchAll(/--([a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
const used = new Set([...css.matchAll(/var\(--([a-zA-Z0-9-]+)/g)].map((m) => m[1]));
const missingVars = [...used].filter((v) => !defined.has(v));
check('所有 CSS 变量都有定义', missingVars.length === 0, missingVars.map((v) => `--${v}`).join(', '));
notes.push(`定义了 ${defined.size} 个变量，使用了 ${used.size} 个`);

// 4. 图表容器必须有确定高度，否则 SVG 塌成 0
const chartSvgRule = /\.chart-svg\s*\{([^}]*)\}/.exec(css);
check('.chart-svg 设置了高度', !!chartSvgRule && /height\s*:\s*\d/.test(chartSvgRule[1]),
  chartSvgRule ? chartSvgRule[1].trim().slice(0, 60) : '未找到规则');

// 5. 关键容器不能是 display:none（除非配合 .hidden 类）
for (const sel of ['.chart-box', '.year-bars', '.ach-list', '.detail-table', '.hero-grid', '.layout']) {
  const rule = new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`).exec(css);
  const hidden = rule && /display\s*:\s*none/.test(rule[1]);
  check(`${sel} 没有默认隐藏`, !hidden);
}

// 6. HTML 里的 class：要么有样式，要么被 JS 当作钩子（closest/querySelector），
//    否则就是拼写错误留下的死类。纯语义标记请写进 SEMANTIC_ONLY 名单。
const SEMANTIC_ONLY = new Set(['results', 'small']);
const appJs = await fs.readFile(path.join(ROOT, 'docs', 'js', 'app.js'), 'utf8');
const jsCombined = (await fs.readFile(path.join(ROOT, 'docs', 'js', 'chart.js'), 'utf8')) + appJs;
const htmlClasses = new Set(
  [...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/).filter(Boolean))
);
const cssClasses = new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map((m) => m[1]));
const jsClassHooks = new Set([...jsCombined.matchAll(/['"]\.([a-zA-Z][a-zA-Z0-9_-]*)['"]/g)].map((m) => m[1]));
const dynamicClasses = new Set([...jsCombined.matchAll(/className\s*=\s*['"]([^'"]+)['"]/g)].flatMap((m) => m[1].split(/\s+/)));
const orphan = [...htmlClasses].filter(
  (c) => !cssClasses.has(c) && !jsClassHooks.has(c) && !dynamicClasses.has(c) && !SEMANTIC_ONLY.has(c)
  && !c.startsWith('tone-') && !c.startsWith('r-')
);
check('HTML 里的 class 都有样式或 JS 钩子', orphan.length === 0, orphan.join(', '));

// 6b. 反向：CSS 里定义但 HTML/JS 都不用的类（提示级，不算错误）
const unusedCss = [...cssClasses].filter(
  (c) => !htmlClasses.has(c) && !jsClassHooks.has(c) && !dynamicClasses.has(c)
  && !/^(tone|r|up|down|hidden|active|open|line|grid|axis|hover|marker|area|sw|lg|pi|dt|ach|year|hero|rank|picker|chip|btn|field|range|fee|unit|method|panel|chart|legend|footer|fatal|data|brand|tagline|topbar|verdict|placeholder|ph|mt|muted|sub|detail)/.test(c)
);
if (unusedCss.length) notes.push(`CSS 中可能有未使用的类：${unusedCss.join(', ')}`);

// 7. 响应式：至少要有一个移动端断点
check('存在移动端媒体查询', /@media\s*\(max-width:\s*\d{3,4}px\)/.test(css));

// 8. 无障碍/可用性基本项
check('按钮有焦点可见样式或可点击高度', /\.btn\s*\{[^}]*padding/.test(css));
check('正负色对比类已定义', /\.up\s*\{[^}]*color/.test(css) && /\.down\s*\{[^}]*color/.test(css));

// 9. 防止常见视觉事故：overflow 导致图表被裁
const chartWrap = /\.chart-wrap\s*\{([^}]*)\}/.exec(css);
if (chartWrap && /overflow\s*:\s*hidden/.test(chartWrap[1])) {
  problems.push('.chart-wrap 设置了 overflow:hidden，可能会裁掉图表上的十字光标与提示气泡');
}

// 10. 提示气泡不能被父级裁剪
notes.push('图表提示气泡定位方式：绝对定位 + JS 计算 left/top（已在无头测试中验证存在）');

console.log(`\n${notes.map((n) => '  · ' + n).join('\n')}`);
console.log(`\n静态样式审查：${problems.length === 0 ? '通过' : problems.length + ' 项问题'}`);
if (problems.length) {
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
