// incident = 线上问题排查。它和 bug/需求一样是日常主线工作：很多时候还没定性成缺陷，
// 但「谁正在排查什么线上问题」本身就是看板最需要暴露的信息。
export const KINDS = ['incident', 'bug', 'feature', 'chore'];
// 确认是独立于开发的一个阶段：提出来的 bug 可能是误报，提出来的需求可能不做，
// 所以「待确认」和「已确认待开工」必须分开，「已完成」和「不做」也必须分开。
export const STATUSES = ['pending', 'confirmed', 'in_progress', 'review', 'blocked', 'done', 'rejected'];
export const AGENTS = ['cursor', 'codex', 'claude', 'other'];
/** 条目事件类型。排查区间独立于 status：一个条目可以在同一状态下被反复开始/结束排查 */
export const ITEM_EVENTS = ['progress', 'investigate_start', 'investigate_end'];

const KIND_ALIASES = {
  线上问题: 'incident',
  线上: 'incident',
  排查: 'incident',
  问题排查: 'incident',
  故障: 'incident',
  事故: 'incident',
  investigation: 'incident',
  investigate: 'incident',
  troubleshoot: 'incident',
  oncall: 'incident',
  on_call: 'incident',
  outage: 'incident',
  sev: 'incident',
  缺陷: 'bug',
  bugfix: 'bug',
  fix: 'bug',
  需求: 'feature',
  feat: 'feature',
  feature_request: 'feature',
  任务: 'chore',
  refactor: 'chore',
  docs: 'chore',
  test: 'chore',
};

// 兼容 agent 可能写出的常见状态别名，避免重演自由文本状态列。
// open 是旧枚举值，现在退化成 pending 的别名：历史事件回放后会落到「待确认」，
// 这比落到「已确认」安全——没人确认过的事情不该显示成已排期。
const STATUS_ALIASES = {
  open: 'pending',
  todo: 'pending',
  new: 'pending',
  observed: 'pending',
  reported: 'pending',
  triage: 'pending',
  未开始: 'pending',
  待确认: 'pending',
  待评估: 'pending',
  未确认: 'pending',
  accepted: 'confirmed',
  ready: 'confirmed',
  planned: 'confirmed',
  backlog: 'confirmed',
  已确认: 'confirmed',
  待开工: 'confirmed',
  待排期: 'confirmed',
  已排期: 'confirmed',
  doing: 'in_progress',
  in_fix: 'in_progress',
  fixing: 'in_progress',
  wip: 'in_progress',
  进行中: 'in_progress',
  开发中: 'in_progress',
  reviewing: 'review',
  in_review: 'review',
  pending_review: 'review',
  待评审: 'review',
  待验证: 'review',
  verifying: 'review',
  blocking: 'blocked',
  阻塞: 'blocked',
  卡住: 'blocked',
  fixed: 'done',
  closed: 'done',
  merged: 'done',
  completed: 'done',
  已完成: 'done',
  已修复: 'done',
  wontfix: 'rejected',
  invalid: 'rejected',
  duplicate: 'rejected',
  cancelled: 'rejected',
  canceled: 'rejected',
  不做: 'rejected',
  不修: 'rejected',
  误报: 'rejected',
  重复: 'rejected',
  无需处理: 'rejected',
  已取消: 'rejected',
};

const EVENT_ALIASES = {
  start: 'investigate_start',
  begin: 'investigate_start',
  investigate: 'investigate_start',
  investigating: 'investigate_start',
  开始: 'investigate_start',
  开始排查: 'investigate_start',
  end: 'investigate_end',
  finish: 'investigate_end',
  finished: 'investigate_end',
  stop: 'investigate_end',
  结束: 'investigate_end',
  结束排查: 'investigate_end',
  排查完成: 'investigate_end',
  note: 'progress',
  update: 'progress',
  进展: 'progress',
};

function str(value, fallback = '') {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function pickEnum(value, allowed, aliases, fallback) {
  const raw = str(value).toLowerCase();
  if (!raw) return fallback;
  if (allowed.includes(raw)) return raw;
  const aliased = aliases[raw] ?? aliases[str(value)];
  return aliased && allowed.includes(aliased) ? aliased : fallback;
}

export const DEFAULT_KIND = 'feature';
// 漏填 status 时宁可显示成「待确认」也不要显示成「开发中」：
// 前者只是少了一次上报，后者会让人以为有人在做而其实没有。
export const DEFAULT_STATUS = 'pending';
export const DEFAULT_EVENT = 'progress';

export function normalizeKind(value) {
  return pickEnum(value, KINDS, KIND_ALIASES, DEFAULT_KIND);
}

export function normalizeStatus(value) {
  return pickEnum(value, STATUSES, STATUS_ALIASES, DEFAULT_STATUS);
}

export function normalizeAgent(value) {
  return pickEnum(value, AGENTS, {}, 'other');
}

export function normalizeItemEvent(value) {
  return pickEnum(value, ITEM_EVENTS, EVENT_ALIASES, DEFAULT_EVENT);
}

/** 归一化标题用于无 id 上报时的去重匹配：去掉空白、标点、大小写差异 */
export function titleKey(title) {
  return str(title)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[`~!@#$%^&*()_\-+=[\]{}|\\:;"'<>,.?/！￥…（）—【】、；：“”‘’《》，。？]/g, '');
}

/** 项目名归一化：绝对路径只取最后一段，统一小写 */
export function normalizeProject(value) {
  const raw = str(value);
  if (!raw) return '';
  const segments = raw.split(/[/\\]/).filter(Boolean);
  return (segments.at(-1) ?? raw).toLowerCase();
}

function limitText(value, max) {
  const raw = str(value);
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

export function normalizeRefs(refs) {
  if (!Array.isArray(refs)) return [];
  return refs.map((ref) => limitText(ref, 500)).filter(Boolean).slice(0, 10);
}

/**
 * 校验上报体。宽松策略：除了 project 和至少一个 title，其余字段一律填默认值而非报错。
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function parseReport(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'body 必须是 JSON 对象' };
  }

  const project = normalizeProject(body.project ?? body.repo ?? body.cwd);
  if (!project) return { ok: false, error: 'project 不能为空' };

  // 允许扁平单条写法：{ project, title, progress, ... }，等价于 items: [ 同样的字段 ]。
  // 手写 curl 是主要上报方式，少一层数组能少一大半格式错误；而且缺 items 的请求会
  // 静默退化成心跳，不做这层糖的话「报了但看板没条目」会很难查。
  const rawItems = Array.isArray(body.items) && body.items.length ? body.items : body.title ? [body] : [];
  const items = [];
  for (const raw of rawItems.slice(0, 20)) {
    if (!raw || typeof raw !== 'object') continue;
    const title = limitText(raw.title, 200);
    if (!title) continue;
    // 未提供的 kind/status 留空，由 store 在「新建」时才填默认值。
    // 否则更新已有条目时，默认值会静默覆盖原有分类（把 bug 改成 feature）。
    items.push({
      id: limitText(raw.id, 64),
      kind: raw.kind ? normalizeKind(raw.kind) : '',
      status: raw.status ? normalizeStatus(raw.status) : '',
      event: normalizeItemEvent(raw.event),
      title,
      progress: limitText(raw.progress ?? raw.note, 500),
      refs: normalizeRefs(raw.refs),
    });
  }

  return {
    ok: true,
    value: {
      project,
      agent: normalizeAgent(body.agent),
      actor: limitText(body.actor, 64) || 'unknown',
      branch: limitText(body.branch, 120),
      session: limitText(body.session ?? body.session_id, 128),
      summary: limitText(body.summary, 300),
      items,
    },
  };
}
