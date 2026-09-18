/**
 * AutoBoard 安装用模板与落地逻辑（CLI / 服务端 /install-bundle 共用）。
 * 协议变更时：技能正文仍改 skills/AutoBoard上报/SKILL.md，AGENTS 段改这里的 renderAgentsSection。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..');
const TEMPLATE = join(REPO_ROOT, 'skills', 'AutoBoard上报', 'SKILL.md');

export const SKILL_NAME = 'AutoBoard上报';
export const LEGACY_SKILL_NAME = '团队看板上报';
export const AGENTS_MARKER = '<!-- autoboard:begin -->';
export const AGENTS_END = '<!-- autoboard:end -->';
export const LEGACY_AGENTS_MARKER = '<!-- team-board:begin -->';
export const LEGACY_AGENTS_END = '<!-- team-board:end -->';

/** 相对 .cursor 那份 SKILL.md 的软链目标（从 .codex/.claude/skills/<name>/ 出发） */
const SKILL_LINK_TARGET = join('..', '..', '..', '.cursor', 'skills', SKILL_NAME, 'SKILL.md');

export function renderSkill(boardUrl) {
  const template = readFileSync(TEMPLATE, 'utf8');
  return template.replaceAll('<BOARD_URL>', boardUrl);
}

export function renderAgentsSection(boardUrl) {
  return `${AGENTS_MARKER}
## AutoBoard 上报（强制）

本项目的线上问题排查、bug、需求进展统一上报到自动看板 ${boardUrl} ，任何 agent
（Cursor / Codex / Claude）都要遵守。**直接 POST 到这个地址，不依赖任何本地脚本或本机路径。**

**何时上报**：开始/结束排查线上问题、登记新的 bug/需求、确认做不做、定位到缺陷原因、推进或完成需求、提交评审、被卡住、状态变化。纯查询和只读浏览不上报。

**bug / 需求进展**（每轮实质性工作结束前执行一次）：

\`\`\`bash
curl -s -X POST ${boardUrl}/api/report -H 'content-type: application/json' -d '{
  "project": "<当前仓库目录名>", "actor": "<git config user.name 的值>", "agent": "cursor",
  "kind": "bug", "status": "in_progress",
  "title": "一句话说清是什么问题", "progress": "本轮做了什么/卡在哪"
}'
\`\`\`

**提出 ≠ 要做**：刚收到、还没拍板的 bug/需求先报 \`"status": "pending"\`；
确认要做但没开工报 \`"confirmed"\`；确认不做（误报/重复/砍掉）报 \`"rejected"\` 并把理由写进 \`progress\`。
不要一登记就写 \`in_progress\`，那会让别人以为已经有人动手了。

**排查线上问题**（和 bug/需求平级的日常动作，开始与结束各报一次，看板据此算排查耗时）：

\`\`\`bash
# 开始排查：一接到线上反馈就报，不要等查清楚
curl -s -X POST ${boardUrl}/api/report -H 'content-type: application/json' -d '{
  "project": "<仓库目录名>", "actor": "<你的名字>", "agent": "cursor",
  "kind": "incident", "event": "start",
  "title": "线上问题一句话", "progress": "现象与当前线索"
}'

# 结束排查：title 必须和开始时一字不差，否则算不出耗时
curl -s -X POST ${boardUrl}/api/report -H 'content-type: application/json' -d '{
  "project": "<仓库目录名>", "actor": "<你的名字>", "agent": "cursor",
  "event": "end", "status": "done",
  "title": "线上问题一句话", "progress": "根因与结论"
}'
\`\`\`

- \`kind\`: \`incident\`（线上问题排查）| \`bug\` | \`feature\` | \`chore\`
- \`status\`: \`pending\` 待确认 | \`confirmed\` 已确认待开工 | \`in_progress\` 开发中 | \`review\` 待评审/待验证 | \`blocked\` 被卡住 | \`done\` 已完成 | \`rejected\` 不做（**只能取这七个值**，交付细节和拍板理由写进 \`progress\`）
- 更新时不传 \`status\` 就保持原状态；只想追加一条进展时不要顺手带状态
- \`event\`: 只在排查时用，\`start\` 开始排查 / \`end\` 结束排查；普通进展不要带
- \`project\` 填当前仓库目录名，\`actor\` 不知道就先跑 \`git config user.name\`；可另加 \`"branch"\` 与 \`"refs": ["链接"]\`
- **同一件事后续上报必须复用完全相同的 \`title\`，或带上首次返回的 \`id\`**，否则会产生重复条目，\`end\` 也会算不出耗时
- 返回 \`{"ok":true,...}\` 即成功；连不上看板就跳过，不要因为上报失败中断手上的工作

详细说明见技能 \`${SKILL_NAME}\`。
${AGENTS_END}`;
}

export function buildInstallBundle(boardUrl) {
  return {
    boardUrl,
    skillName: SKILL_NAME,
    skillMd: renderSkill(boardUrl),
    agentsSection: renderAgentsSection(boardUrl),
    agentsMarker: AGENTS_MARKER,
    agentsEnd: AGENTS_END,
    legacyAgentsMarker: LEGACY_AGENTS_MARKER,
    legacyAgentsEnd: LEGACY_AGENTS_END,
    legacySkillName: LEGACY_SKILL_NAME,
  };
}

function ensureSymlink(linkPath, target) {
  if (existsSync(linkPath) || lstatSync(linkPath, { throwIfNoEntry: false })) {
    unlinkSync(linkPath);
  }
  symlinkSync(target, linkPath);
}

function stripLegacyAgentsSection(text) {
  const start = text.indexOf(LEGACY_AGENTS_MARKER);
  if (start === -1) return text;
  const end = text.indexOf(LEGACY_AGENTS_END);
  if (end === -1) return text;
  return text.slice(0, start) + text.slice(end + LEGACY_AGENTS_END.length);
}

export function patchAgentsFile(repo, agentsSection, dryRun = false) {
  const file = join(repo, 'AGENTS.md');
  let existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  existing = stripLegacyAgentsSection(existing);

  let next;
  if (existing.includes(AGENTS_MARKER)) {
    const start = existing.indexOf(AGENTS_MARKER);
    const end = existing.indexOf(AGENTS_END);
    if (end === -1) return { action: 'skipped', reason: '标记不完整，需手工处理' };
    next = existing.slice(0, start) + agentsSection + existing.slice(end + AGENTS_END.length);
    if (next === existing) return { action: 'unchanged' };
    if (!dryRun) writeFileSync(file, next, 'utf8');
    return { action: 'updated' };
  }

  const separator = existing.trim() ? `${existing.trimEnd()}\n\n` : '';
  next = `${separator}${agentsSection}\n`;
  if (!dryRun) writeFileSync(file, next, 'utf8');
  return { action: existing ? 'appended' : 'created' };
}

function removeLegacySkillDirs(repo, dryRun) {
  for (const root of [
    join(repo, '.cursor', 'skills'),
    join(repo, '.codex', 'skills'),
    join(repo, '.claude', 'skills'),
  ]) {
    const legacy = join(root, LEGACY_SKILL_NAME);
    if (!existsSync(legacy) && !lstatSync(legacy, { throwIfNoEntry: false })) continue;
    if (!dryRun) rmSync(legacy, { recursive: true, force: true });
  }
}

/**
 * 把 skill + AGENTS.md 写入目标 git 仓库。
 * @returns {{ ok: boolean, agents?: object, reason?: string }}
 */
export function installIntoRepo(repo, { skillMd, agentsSection, dryRun = false } = {}) {
  if (!existsSync(join(repo, '.git'))) {
    return { ok: false, reason: '不是 git 仓库' };
  }

  const cursorDir = join(repo, '.cursor', 'skills', SKILL_NAME);
  const linkRoots = [
    join(repo, '.codex', 'skills', SKILL_NAME),
    join(repo, '.claude', 'skills', SKILL_NAME),
  ];

  if (!dryRun) {
    removeLegacySkillDirs(repo, dryRun);
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(join(cursorDir, 'SKILL.md'), skillMd, 'utf8');
    for (const dir of linkRoots) {
      mkdirSync(dir, { recursive: true });
      // 软链文件而不是目录：目录软链在 isDirectory() 判定下可能被技能发现逻辑跳过
      ensureSymlink(join(dir, 'SKILL.md'), SKILL_LINK_TARGET);
    }
  }

  const agents = patchAgentsFile(repo, agentsSection, dryRun);
  return { ok: true, agents };
}
