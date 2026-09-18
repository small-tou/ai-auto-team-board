import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EVENT, DEFAULT_KIND, DEFAULT_STATUS, normalizeKind, normalizeStatus, titleKey } from './schema.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.BOARD_DATA_DIR || join(here, '..', 'data');
const EVENTS_FILE = join(DATA_DIR, 'events.jsonl');
const SNAPSHOT_FILE = join(DATA_DIR, 'board.json');

const MAX_TIMELINE = 30;
const MAX_EVENT_TAIL = 200;

/** 内存投影：唯一写入者是服务进程，所以追加写天然串行安全 */
const state = {
  items: new Map(), // `${project}::${id}` -> item
  projects: new Map(), // project -> { project, lastSeenAt, agents: Map, branches: Set }
  tail: [], // 最近事件，供前端事件流
  seq: 0,
};

function nowIso() {
  return new Date().toISOString();
}

function dateStamp(iso) {
  return iso.slice(0, 10).replace(/-/g, '');
}

function itemKey(project, id) {
  return `${project}::${id}`;
}

function nextItemId(project, kind, iso) {
  const prefix = { incident: 'INC', bug: 'BUG', feature: 'FEAT', chore: 'CHORE' }[kind] ?? 'ITEM';
  const stamp = dateStamp(iso);
  let n = 1;
  while (state.items.has(itemKey(project, `${prefix}-${stamp}-${String(n).padStart(3, '0')}`))) n += 1;
  return `${prefix}-${stamp}-${String(n).padStart(3, '0')}`;
}

function touchProject(project, { agent, actor, branch, at }) {
  let entry = state.projects.get(project);
  if (!entry) {
    entry = { project, firstSeenAt: at, lastSeenAt: at, agents: new Map(), branches: new Set() };
    state.projects.set(project, entry);
  }
  entry.lastSeenAt = at;
  if (branch) entry.branches.add(branch);
  if (agent) entry.agents.set(`${agent}:${actor}`, { agent, actor, lastSeenAt: at });
  return entry;
}

function pushTail(event) {
  state.tail.push(event);
  if (state.tail.length > MAX_EVENT_TAIL) state.tail.splice(0, state.tail.length - MAX_EVENT_TAIL);
}

/**
 * 查找已有条目：优先 id，其次同项目内归一化标题匹配。
 * 这是「每轮对话都上报」不会把看板刷爆的关键。
 */
function findItem(project, { id, title }) {
  if (id) {
    const direct = state.items.get(itemKey(project, id));
    if (direct) return direct;
  }
  const key = titleKey(title);
  if (!key) return null;
  for (const item of state.items.values()) {
    if (item.project === project && item.titleKey === key) return item;
  }
  return null;
}

function pushTimeline(item, entry) {
  item.timeline.push(entry);
  if (item.timeline.length > MAX_TIMELINE) {
    item.timeline.splice(0, item.timeline.length - MAX_TIMELINE);
  }
}

/**
 * 排查区间独立于 status：同一条目可以被反复「开始排查 → 结束排查」。
 * 只维护一段进行中的排查，重复 start 保留最早的开始时间，避免把已经花掉的时间清零。
 * 耗时全部由事件里的 at 推导，所以日志回放能还原出完全一致的结果。
 */
function applyInvestigation(item, event) {
  const type = event.item.event || DEFAULT_EVENT;

  if (type === 'investigate_start') {
    if (item.investigating) {
      return { type, since: item.investigating.since, duplicated: true };
    }
    item.investigating = { since: event.at, actor: event.actor, agent: event.agent };
    return { type, since: event.at };
  }

  if (type === 'investigate_end') {
    const since = item.investigating?.since ?? null;
    // 没有配对的 start（比如服务重启前就开始排查了）就只记事件，不编造耗时
    const durationMs = since ? Math.max(0, Date.parse(event.at) - Date.parse(since)) : null;
    item.investigating = null;
    if (durationMs !== null) {
      item.investigateMs += durationMs;
      item.investigateCount += 1;
    }
    return { type, since, durationMs };
  }

  return null;
}

/** 应用一条事件到内存投影。回放与实时写入共用，保证两者一致。 */
function applyEvent(event) {
  state.seq = Math.max(state.seq, event.seq ?? 0);
  const at = event.at;
  touchProject(event.project, event);

  if (event.type === 'ping') {
    pushTail(event);
    return { kind: 'ping' };
  }

  if (event.type !== 'item') return { kind: 'ignored' };

  const existing = findItem(event.project, event.item);
  // 事件日志里存的是写入当时的枚举值，枚举演进后（例如 open 拆成 pending/confirmed）
  // 回放必须重新归一化，否则历史条目会带着已废弃的状态值渲染成无样式的裸字符串。
  // 空值要保持为空：那代表「本次不改状态」，归一化会把它变成默认值从而覆盖原状态。
  const incoming = {
    ...event.item,
    kind: event.item.kind ? normalizeKind(event.item.kind) : '',
    status: event.item.status ? normalizeStatus(event.item.status) : '',
  };

  if (existing) {
    const changedStatus = incoming.status && incoming.status !== existing.status;
    if (changedStatus) existing.status = incoming.status;
    if (incoming.kind) existing.kind = incoming.kind;
    if (incoming.title) {
      existing.title = incoming.title;
      existing.titleKey = titleKey(incoming.title);
    }
    if (incoming.refs?.length) existing.refs = incoming.refs;
    if (incoming.progress) existing.progress = incoming.progress;
    existing.actor = event.actor || existing.actor;
    existing.agent = event.agent || existing.agent;
    if (event.branch) existing.branch = event.branch;
    existing.updatedAt = at;
    existing.reportCount += 1;

    const investigation = applyInvestigation(existing, event);
    // 重复 start 没有真正开启新的排查区间，timeline 里就不要打「开始排查」标，
    // 否则看上去像开了两段排查
    const marks = investigation && !investigation.duplicated ? investigation : null;

    if (incoming.progress || changedStatus || marks) {
      pushTimeline(existing, {
        at,
        actor: event.actor,
        agent: event.agent,
        status: existing.status,
        progress: incoming.progress,
        ...(marks ? { event: marks.type, durationMs: marks.durationMs ?? null } : {}),
      });
    }
    pushTail({ ...event, itemId: existing.id, resolution: 'updated', investigation });
    return { kind: 'item', action: 'updated', item: existing, investigation };
  }

  const kind = incoming.kind || DEFAULT_KIND;
  const status = incoming.status || DEFAULT_STATUS;
  const id = incoming.id || nextItemId(event.project, kind, at);
  const item = {
    id,
    project: event.project,
    kind,
    status,
    title: incoming.title,
    titleKey: titleKey(incoming.title),
    progress: incoming.progress,
    refs: incoming.refs ?? [],
    actor: event.actor,
    agent: event.agent,
    branch: event.branch,
    createdAt: at,
    updatedAt: at,
    reportCount: 1,
    investigating: null,
    investigateMs: 0,
    investigateCount: 0,
    timeline: [],
  };
  // 「开始排查线上问题」往往就是条目的第一条事件，所以建条目和开排查走同一条路径
  const investigation = applyInvestigation(item, event);
  pushTimeline(item, {
    at,
    actor: event.actor,
    agent: event.agent,
    status,
    progress: incoming.progress,
    ...(investigation ? { event: investigation.type, durationMs: investigation.durationMs ?? null } : {}),
  });
  state.items.set(itemKey(event.project, id), item);
  pushTail({ ...event, itemId: id, resolution: 'created', investigation });
  return { kind: 'item', action: 'created', item, investigation };
}

function writeEvent(event) {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(EVENTS_FILE, `${JSON.stringify(event)}\n`, 'utf8');
}

function writeSnapshot() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${SNAPSHOT_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(board(), null, 2), 'utf8');
  renameSync(tmp, SNAPSHOT_FILE);
}

export function load() {
  if (!existsSync(EVENTS_FILE)) return { events: 0 };
  const lines = readFileSync(EVENTS_FILE, 'utf8').split('\n');
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      applyEvent(JSON.parse(trimmed));
      count += 1;
    } catch {
      // 坏行跳过：事件日志是追加式的，不能因为一行损坏就拒绝启动
    }
  }
  return { events: count };
}

export function recordPing(payload) {
  const event = {
    seq: (state.seq += 1),
    type: 'ping',
    at: nowIso(),
    project: payload.project,
    agent: payload.agent,
    actor: payload.actor,
    branch: payload.branch,
    session: payload.session,
    summary: payload.summary,
  };
  writeEvent(event);
  applyEvent(event);
  writeSnapshot();
  return { project: event.project, at: event.at };
}

export function recordReport(payload) {
  const at = nowIso();
  const results = [];
  for (const item of payload.items) {
    const event = {
      seq: (state.seq += 1),
      type: 'item',
      at,
      project: payload.project,
      agent: payload.agent,
      actor: payload.actor,
      branch: payload.branch,
      session: payload.session,
      item,
    };
    writeEvent(event);
    const applied = applyEvent(event);
    if (applied.kind === 'item') {
      results.push({
        id: applied.item.id,
        action: applied.action,
        status: applied.item.status,
        kind: applied.item.kind,
        investigation: applied.investigation ?? null,
      });
    }
  }
  if (payload.items.length === 0) {
    return { items: [], ping: recordPing(payload) };
  }
  writeSnapshot();
  return { items: results };
}

/** 终态：已完成和不做都不再占用团队注意力，统计「还欠着多少」时都要排除 */
function isClosed(status) {
  return status === 'done' || status === 'rejected';
}

export function board() {
  const items = [...state.items.values()].map(({ titleKey: _ignored, ...rest }) => rest);
  const projects = [...state.projects.values()]
    .map((entry) => {
      const own = items.filter((item) => item.project === entry.project);
      return {
        project: entry.project,
        firstSeenAt: entry.firstSeenAt,
        lastSeenAt: entry.lastSeenAt,
        branches: [...entry.branches],
        agents: [...entry.agents.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
        counts: {
          total: own.length,
          pending: own.filter((i) => i.status === 'pending').length,
          confirmed: own.filter((i) => i.status === 'confirmed').length,
          in_progress: own.filter((i) => i.status === 'in_progress').length,
          review: own.filter((i) => i.status === 'review').length,
          blocked: own.filter((i) => i.status === 'blocked').length,
          done: own.filter((i) => i.status === 'done').length,
          rejected: own.filter((i) => i.status === 'rejected').length,
          incident: own.filter((i) => i.kind === 'incident' && !isClosed(i.status)).length,
          investigating: own.filter((i) => i.investigating).length,
        },
      };
    })
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));

  return {
    generatedAt: nowIso(),
    projects,
    items: items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    events: state.tail.slice(-80).reverse(),
  };
}

export const paths = { DATA_DIR, EVENTS_FILE, SNAPSHOT_FILE };
