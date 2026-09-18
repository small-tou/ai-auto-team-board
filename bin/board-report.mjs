#!/usr/bin/env node
/**
 * AutoBoard 统一上报入口。各模式共用同一套项目解析与容错逻辑：
 *   hook  ：`board-report.mjs hook`，从 stdin 读 Cursor / Codex / Claude Code 的 hook payload，只发心跳
 *   item  ：`board-report.mjs item --kind bug --title "..." --status in_progress --progress "..."`
 *   start ：`board-report.mjs start --title "线上问题" --progress "..."`  开始排查，默认 kind=incident
 *   end   ：`board-report.mjs end --title "线上问题" --status done --progress "..."`  结束排查并记耗时
 *
 * 铁律：绝不阻塞对话。任何异常都 exit 0，并在 hook 模式下输出合法 JSON。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// 默认指向公网看板；本地起服务调试时用 BOARD_URL=http://127.0.0.1:7788 覆盖
const BOARD_URL = process.env.BOARD_URL || 'https://autoboard.html-js.com';
const BOARD_TOKEN = process.env.BOARD_TOKEN || '';
const TIMEOUT_MS = Number(process.env.BOARD_TIMEOUT_MS || 1500);
const PING_THROTTLE_MS = Number(process.env.BOARD_PING_THROTTLE_MS || 5 * 60 * 1000);
const CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'autoboard');

function quiet(fn, fallback = undefined) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function git(args, cwd) {
  return quiet(() =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 800 }).trim(),
  );
}

/**
 * Resolve the project root. Cursor user-level hooks often have cwd under ~/.cursor,
 * so prefer workspace_roots from the payload; Codex / Claude Code can use cwd.
 */
function resolveRepoRoot(payload) {
  const candidates = [];
  const roots = payload.workspace_roots ?? payload.workspaceRoots;
  if (Array.isArray(roots)) candidates.push(...roots);
  else if (typeof roots === 'string') candidates.push(roots);
  // Claude Code sets CLAUDE_PROJECT_DIR for hooks and MCP servers.
  candidates.push(
    process.env.CLAUDE_PROJECT_DIR,
    payload.workspace_root,
    payload.cwd,
    payload.working_directory,
    process.env.PWD,
    process.cwd(),
  );

  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const dir = resolve(candidate.trim());
    const home = homedir();
    if (
      dir === home ||
      dir.startsWith(join(home, '.cursor')) ||
      dir.startsWith(join(home, '.codex')) ||
      dir.startsWith(join(home, '.claude'))
    ) {
      continue;
    }
    if (!existsSync(dir)) continue;
    return git(['rev-parse', '--show-toplevel'], dir) || dir;
  }
  return '';
}

function detectAgent(payload) {
  if (process.env.BOARD_AGENT) return process.env.BOARD_AGENT;
  // Claude Code exports CLAUDE_PROJECT_DIR for hooks; check before PascalCase events
  // (Claude hook names look like Codex: UserPromptSubmit, SessionStart, …).
  if (
    process.env.CLAUDE_PROJECT_DIR ||
    process.env.CLAUDECODE ||
    process.env.CLAUDE_CODE_ENTRYPOINT
  ) {
    return 'claude';
  }
  // Codex hook events are PascalCase; Cursor uses camelCase.
  const event = payload.hook_event_name ?? payload.hookEventName ?? '';
  if (/^[A-Z]/.test(event)) return 'codex';
  if (event) return 'cursor';
  if (process.env.CODEX_HOME || process.env.CODEX_SANDBOX) return 'codex';
  if (process.env.CURSOR_TRACE_ID) return 'cursor';
  return 'other';
}

function detectActor(repoRoot) {
  return (
    process.env.BOARD_ACTOR ||
    (repoRoot && git(['config', 'user.name'], repoRoot)) ||
    process.env.USER ||
    'unknown'
  );
}

async function post(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BOARD_URL}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(BOARD_TOKEN ? { authorization: `Bearer ${BOARD_TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 同一会话 5 分钟内只发一次心跳，避免每轮对话都写盘 */
function shouldPing(sessionKey) {
  if (!sessionKey) return true;
  const file = join(CACHE_DIR, `${sessionKey.replace(/[^\w.-]/g, '_')}.json`);
  const last = quiet(() => JSON.parse(readFileSync(file, 'utf8')).at, 0);
  if (Date.now() - Number(last || 0) < PING_THROTTLE_MS) return false;
  quiet(() => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ at: Date.now() }), 'utf8');
  });
  return true;
}

function readStdin() {
  return new Promise((resolveStdin) => {
    if (process.stdin.isTTY) return resolveStdin('');
    let raw = '';
    const timer = setTimeout(() => resolveStdin(raw), 800);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (raw += chunk));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolveStdin(raw);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolveStdin(raw);
    });
  });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = 'true';
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function context(payload, { project: explicitProject, agent: explicitAgent, actor: explicitActor } = {}) {
  const repoRoot = resolveRepoRoot(payload);
  const project = explicitProject || repoRoot;
  return {
    project,
    branch: repoRoot ? git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot) || '' : '',
    agent: explicitAgent || detectAgent(payload),
    actor: explicitActor || detectActor(repoRoot),
  };
}

async function runHook() {
  const raw = await readStdin();
  const payload = quiet(() => JSON.parse(raw), {}) ?? {};
  const ctx = context(payload);
  if (ctx.project) {
    const session = payload.session_id ?? payload.sessionId ?? payload.conversation_id ?? payload.thread_id ?? '';
    if (shouldPing(`${ctx.agent}-${session || ctx.project}`)) {
      await post('/api/ping', { ...ctx, session, summary: '' });
    }
  }
  // Cursor 要求 hook 输出合法 JSON；Codex 忽略多余字段，输出空对象两边都安全
  process.stdout.write('{}');
}

function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.round(ms / 60000);
  if (min < 1) return `${Math.round(ms / 1000)} 秒`;
  if (min < 60) return `${min} 分钟`;
  const hour = Math.floor(min / 60);
  return `${hour} 小时 ${min % 60} 分钟`;
}

const EVENT_LABEL = { investigate_start: '开始排查', investigate_end: '结束排查' };

/**
 * @param {Record<string,string>} defaults start/end 子命令的默认值，显式参数优先
 */
async function runItem(argv, defaults = {}) {
  const args = parseArgs(argv);
  if (!args.title) {
    console.error(
      '缺少 --title。用法：\n' +
        '  board-report item  --kind incident|bug|feature|chore --title "..." --progress "..."\n' +
        '                     --status pending|confirmed|in_progress|review|blocked|done|rejected\n' +
        '                     [--id ID] [--ref URL] [--agent cursor|codex|claude] [--project NAME]\n' +
        '  board-report start --title "线上问题一句话" --progress "现象/线索"            # 开始排查，默认 kind=incident\n' +
        '  board-report end   --title "同一个标题" --status done --progress "结论"       # 结束排查，记录耗时',
    );
    return;
  }
  const ctx = context({}, args);
  if (!ctx.project) {
    console.error('无法判断当前项目（不在 git 仓库内？可用 --project 指定）');
    return;
  }
  const result = await post('/api/report', {
    ...ctx,
    items: [
      {
        id: args.id,
        kind: args.kind || defaults.kind,
        status: args.status || defaults.status,
        event: args.event || defaults.event,
        title: args.title,
        progress: args.progress,
        refs: args.ref ? [args.ref] : [],
      },
    ],
  });
  if (!result?.ok) {
    console.error(`[autoboard] 上报未成功: ${result?.error ?? '未知错误'}`);
    return;
  }
  const item = result.items?.[0];
  const investigation = item?.investigation;
  const extra = !investigation
    ? ''
    : investigation.duplicated
      ? ' 已在排查中，沿用原开始时间'
      : ` ${EVENT_LABEL[investigation.type] ?? investigation.type}${
          investigation.durationMs != null ? `（耗时 ${humanDuration(investigation.durationMs)}）` : ''
        }`;
  console.log(`[autoboard] ${result.project ?? ctx.project} ${item?.id ?? ''} ${item?.action ?? ''} status=${item?.status ?? ''}${extra}`);
}

async function runPing(argv) {
  const args = parseArgs(argv);
  const ctx = context({}, args);
  if (!ctx.project) return;
  const result = await post('/api/ping', { ...ctx, summary: args.summary ?? '' });
  console.log(result?.ok ? `[autoboard] 心跳已上报 ${ctx.project}` : `[autoboard] 心跳失败: ${result?.error}`);
}

const [mode, ...rest] = process.argv.slice(2);

try {
  if (mode === 'hook') await runHook();
  else if (mode === 'item') await runItem(rest);
  // 开始/结束排查是日常主线动作，给它独立子命令；默认按线上问题登记。
  // 不预设 status：新问题落到默认的 pending（正在查但还没定性），已有条目保持原状态。
  else if (mode === 'start') await runItem(rest, { kind: 'incident', event: 'investigate_start' });
  else if (mode === 'end') await runItem(rest, { kind: 'incident', event: 'investigate_end' });
  else if (mode === 'ping') await runPing(rest);
  else {
    console.error('用法：board-report <hook|item|start|end|ping> [options]');
  }
} catch (error) {
  // 服务没启动、超时、网络异常都走这里：静默跳过，绝不影响对话
  if (mode === 'hook') process.stdout.write('{}');
  else console.error(`[autoboard] 跳过上报：${error.message}`);
}

process.exit(0);
