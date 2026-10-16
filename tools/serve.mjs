#!/usr/bin/env node
/**
 * 极简本地静态服务器（只为本地预览，生产环境用 GitHub Pages）。
 * 用法：node tools/serve.mjs [port]   默认 http://127.0.0.1:4173
 * 说明：页面本身用 file:// 直接双击也能跑（数据库是 <script> 加载的），
 *       这个服务器只是为了让 ES module 的 MIME 类型、缓存行为与线上一致。
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(path.resolve(__dirname, '..'), 'docs');
const PORT = Number(process.argv[2] || process.env.PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel.endsWith('/')) rel += 'index.html';
    const full = path.join(ROOT, rel);
    // 目录穿越防护
    if (!full.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const data = await fs.readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`本地预览：http://127.0.0.1:${PORT}/  （根目录 docs/，Ctrl+C 退出）`);
});
