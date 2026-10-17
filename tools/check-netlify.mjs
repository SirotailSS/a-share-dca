// 轻量 TOML 结构检查（不追求完整解析，只抓 netlify.toml 会踩的典型语法错）
import fs from 'node:fs';

const text = fs.readFileSync('netlify.toml', 'utf8');
const errors = [];

// 1) 引号成对
const dq = (text.match(/"/g) || []).length;
if (dq % 2 !== 0) errors.push(`双引号数量为奇数（${dq}），必然有未闭合字符串`);

// 2) 括号成对（TOML 里主要是数组/内联表）
if ((text.match(/\[/g) || []).length !== (text.match(/\]/g) || []).length) {
  errors.push('方括号不配对');
}

// 3) 逐行检查：要么是注释/空行/表头，要么是 key = value
const lines = text.split(/\r?\n/);
const sections = [];
let currentSection = '(root)';
const keysBySection = new Map();

lines.forEach((raw, idx) => {
  const line = raw.trim();
  const ln = idx + 1;
  if (!line || line.startsWith('#')) return;

  // 表头
  if (/^\[\[?[^\]]+\]\]?$/.test(line)) {
    if (!/^\[\[?[A-Za-z0-9_.-]+(\.[A-Za-z0-9_.-]+)*\]\]?$/.test(line)) {
      errors.push(`第 ${ln} 行：表头格式可疑 → ${line}`);
    }
    const isArray = line.startsWith('[[');
    currentSection = line.replace(/^\[\[?/, '').replace(/\]\]?$/, '');
    sections.push({ name: currentSection, isArray, line: ln });
    if (!keysBySection.has(currentSection)) keysBySection.set(currentSection, []);
    return;
  }

  // key = value
  const m = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
  if (!m) {
    errors.push(`第 ${ln} 行：既不是表头也不是 key = value → ${line}`);
    return;
  }
  const [, key, val] = m;
  keysBySection.get(currentSection)?.push(key);

  // value 基本形状：字符串 / 布尔 / 数字 / 数组
  if (!/^(".*"|'.*'|true|false|-?\d+(\.\d+)?|\[.*\])$/.test(val.trim())) {
    errors.push(`第 ${ln} 行：value 形态可疑 → ${val}`);
  }
});

// 4) 业务断言：Netlify 必须能读到这两个键
const buildSection = keysBySection.get('build') || [];
if (!buildSection.includes('command')) errors.push('缺少 [build] command');
if (!buildSection.includes('publish')) errors.push('缺少 [build] publish');
const envSection = keysBySection.get('build.environment') || [];
if (!envSection.includes('NODE_VERSION')) errors.push('缺少 [build.environment] NODE_VERSION');

// 5) headers 数组表必须同时带 for 与 values
const headerBlocks = sections.filter((s) => s.name === 'headers').length;
const valuesBlocks = sections.filter((s) => s.name === 'headers.values').length;
if (headerBlocks !== valuesBlocks) {
  errors.push(`[[headers]] 有 ${headerBlocks} 个，但 [headers.values] 有 ${valuesBlocks} 个（应一一对应）`);
}

console.log('=== netlify.toml 结构检查 ===');
console.log(`表头 ${sections.length} 个，headers 规则 ${headerBlocks} 条`);
for (const [name, keys] of keysBySection) {
  console.log(`  [${name}] ${keys.length ? keys.join(', ') : '(空)'}`);
}
if (errors.length) {
  console.log('\n发现 %d 个问题：', errors.length);
  for (const e of errors) console.log('  - ' + e);
  process.exit(1);
}
console.log('\n结构检查通过：没有明显 TOML 语法问题');
