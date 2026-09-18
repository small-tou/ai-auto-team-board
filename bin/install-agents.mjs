#!/usr/bin/env node
/**
 * Install the autoboard-report skill into target repos for Cursor / Codex / Claude.
 *
 *   node bin/install-agents.mjs                    install into cwd
 *   node bin/install-agents.mjs <repo路径...>
 *   node bin/install-agents.mjs --all              install into all git repos under BOARD_SCAN_ROOT (default ~/code/ai)
 *   node bin/install-agents.mjs --check [repo]     check only
 *   node bin/install-agents.mjs --board-url URL …
 *
 * Writes:
 *   <repo>/.cursor/skills/autoboard-report/SKILL.md
 *   <repo>/.codex/skills/…/SKILL.md and .claude/skills/…/SKILL.md  → symlink to the above
 *   <repo>/AGENTS.md  append/update autoboard section
 *   <repo>/CLAUDE.md  ensure `@AGENTS.md` import (Claude Code reads CLAUDE.md)
 *
 * Or from a target repo (no need to clone this repo):
 *   curl -fsSL "$BOARD_URL/install.mjs" | node --input-type=module - --yes
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import {
  SKILL_NAME,
  buildInstallBundle,
  installIntoRepo,
} from '../src/install-assets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');
const CLI_PATH = join(REPO_ROOT, 'bin', 'board-report.mjs');

function parseArgs(argv) {
  const dryRun = argv.includes('--check');
  const all = argv.includes('--all');
  const flagIdx = argv.indexOf('--board-url');
  const boardUrlFlag = flagIdx !== -1 ? argv[flagIdx + 1] : '';
  const positional = argv
    .filter((a, i) => {
      if (a.startsWith('-')) return false;
      if (flagIdx !== -1 && i === flagIdx + 1) return false;
      return true;
    })
    .map((a) => resolve(a));

  const boardUrl = (boardUrlFlag || process.env.BOARD_URL || 'https://autoboard.html-js.com').replace(
    /\/$/,
    '',
  );
  return { dryRun, all, boardUrl, positional };
}

function scanRoot() {
  return process.env.BOARD_SCAN_ROOT
    ? resolve(process.env.BOARD_SCAN_ROOT)
    : join(homedir(), 'code', 'ai');
}

function discoverRepos() {
  const base = scanRoot();
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(base, entry.name))
    .filter((dir) => existsSync(join(dir, '.git')) && dir !== REPO_ROOT);
}

const { dryRun, all, boardUrl, positional } = parseArgs(process.argv.slice(2));
const bundle = buildInstallBundle(boardUrl);

// 无路径参数且非 --all：默认装到当前目录
const targets = positional.length ? positional : all ? discoverRepos() : [process.cwd()];

if (all && targets.length === 0) {
  console.log(`用法：node bin/install-agents.mjs [repo...] | --all | --check [repo]`);
  console.log(`      --board-url <url>   覆盖看板地址（也可用 BOARD_URL）`);
  console.log(`      BOARD_SCAN_ROOT    --all 时的扫描根（默认 ~/code/ai）`);
  console.log(`\n${scanRoot()} 下可安装的仓库：`);
  for (const repo of discoverRepos()) console.log(`  ${repo.replace(homedir(), '~')}`);
  process.exit(0);
}

console.log(`${dryRun ? '检查' : '安装'}「${SKILL_NAME}」到 ${targets.length} 个仓库：`);
for (const repo of targets) {
  const label = repo.replace(homedir(), '~');
  const result = installIntoRepo(repo, {
    skillMd: bundle.skillMd,
    agentsSection: bundle.agentsSection,
    dryRun,
  });
  if (!result.ok) {
    console.log(`  跳过 ${label}（${result.reason}）`);
    continue;
  }
  const agents = result.agents;
  const claude = result.claude;
  console.log(
    `  ${dryRun ? '[检查]' : '[已装]'} ${label}  技能✓  .codex/.claude 软链✓  AGENTS.md ${agents.action}${agents.reason ? `（${agents.reason}）` : ''}  CLAUDE.md ${claude.action}${claude.reason ? `（${claude.reason}）` : ''}`,
  );
}
console.log(`\n可选 CLI：${CLI_PATH}`);
console.log(`看板地址：${boardUrl}`);
console.log(`一键安装（任意仓库，无需本仓库）：curl -fsSL ${boardUrl}/install.mjs | node --input-type=module - --yes`);
