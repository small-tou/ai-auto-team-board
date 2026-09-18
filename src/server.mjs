import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReport } from './schema.mjs';
import { board, load, paths, recordPing, recordReport } from './store.mjs';
import { buildInstallBundle } from './install-assets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, '..', 'public');
const REMOTE_INSTALL_TEMPLATE = readFileSync(join(here, 'remote-install.mjs'), 'utf8');

const PORT = Number(process.env.BOARD_PORT || 7788);
const HOST = process.env.BOARD_HOST || '127.0.0.1';
const TOKEN = process.env.BOARD_TOKEN || '';
const PUBLIC_URL = (process.env.BOARD_PUBLIC_URL || '').replace(/\/$/, '');
const BOARD_TITLE = process.env.BOARD_TITLE || 'AutoBoard';
const BOARD_ICON = process.env.BOARD_ICON || '/favicon.svg';
const MAX_BODY = 256 * 1024;

/** 转义写入 HTML 文本/属性时的特殊字符，防止 env 注入破坏页面 */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** v1 本地使用默认不鉴权；设置 BOARD_TOKEN 后才校验，方便后续上内网 */
function authorized(req) {
  if (!TOKEN) return true;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  return bearer === TOKEN || req.headers['x-board-token'] === TOKEN;
}

/** 安装包里嵌入的对外地址：环境变量优先，否则按请求 Host / 反代头推导 */
function publicBoardUrl(req, url) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = xfProto || url.protocol.replace(':', '') || 'http';
  const xfHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = xfHost || req.headers.host || `${HOST}:${PORT}`;
  return `${proto}://${host}`.replace(/\/$/, '');
}

function sendText(res, status, body, contentType) {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function serveStatic(res, urlPath) {
  const file = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (file.includes('..')) {
    sendJson(res, 400, { ok: false, error: '非法路径' });
    return;
  }
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };
  const ext = file.slice(file.lastIndexOf('.'));
  try {
    let content = await readFile(join(PUBLIC_DIR, file));
    // 首页注入部署侧品牌：title / 页头文案 / favicon
    if (file === 'index.html') {
      const html = content
        .toString('utf8')
        .replaceAll('__BOARD_TITLE__', escapeHtml(BOARD_TITLE))
        .replaceAll('__BOARD_ICON__', escapeHtml(BOARD_ICON));
      return sendText(res, 200, html, types['.html']);
    }
    res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(content);
  } catch {
    sendJson(res, 404, { ok: false, error: '未找到' });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? HOST}`);
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/health') {
    return sendJson(res, 200, { ok: true, service: 'autoboard', port: PORT });
  }

  if (route === 'GET /api/board') {
    return sendJson(res, 200, { ok: true, ...board() });
  }

  if (route === 'GET /api/install-bundle') {
    const boardUrl = publicBoardUrl(req, url);
    return sendJson(res, 200, { ok: true, ...buildInstallBundle(boardUrl) });
  }

  if (route === 'GET /install.mjs') {
    const boardUrl = publicBoardUrl(req, url);
    const script = REMOTE_INSTALL_TEMPLATE.replaceAll('__BOARD_URL__', boardUrl);
    return sendText(res, 200, script, 'text/javascript; charset=utf-8');
  }

  if (req.method === 'POST' && (url.pathname === '/api/report' || url.pathname === '/api/ping')) {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'token 无效' });

    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: error.message });
    }

    const parsed = parseReport(body);
    if (!parsed.ok) return sendJson(res, 400, { ok: false, error: parsed.error });

    try {
      const result =
        url.pathname === '/api/ping'
          ? { ping: recordPing(parsed.value) }
          : recordReport(parsed.value);
      return sendJson(res, 200, { ok: true, project: parsed.value.project, ...result });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: `写入失败: ${error.message}` });
    }
  }

  if (req.method === 'GET') return serveStatic(res, url.pathname);

  sendJson(res, 404, { ok: false, error: '未找到' });
});

const loaded = load();
server.listen(PORT, HOST, () => {
  console.log(`[autoboard] http://${HOST}:${PORT}`);
  console.log(`[autoboard] 事件日志 ${paths.EVENTS_FILE}（已回放 ${loaded.events} 条）`);
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
  if (TOKEN) console.log('[autoboard] 已启用 BOARD_TOKEN 写鉴权');
  else if (loopback) console.log('[autoboard] 未设置 BOARD_TOKEN，仅监听本地回环地址');
  else console.warn(`[autoboard] 注意：监听 ${HOST} 且未设置 BOARD_TOKEN，同网段任何人都能读写看板`);
});
