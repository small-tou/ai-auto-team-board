#!/usr/bin/env node
/**
 * 远程一键安装：在目标 git 仓库根目录执行
 *   curl -fsSL "$BOARD_URL/install.mjs" | node --input-type=module - --yes
 *
 * 从看板拉取 skill / AGENTS 段并写入本仓库。零依赖，仅用 Node 内置模块。
 * 服务端会把下方 __BOARD_URL__ 替换成实例地址。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const EMBEDDED_BOARD_URL = '__BOARD_URL__';

function parseArgs(argv) {
  const flagIdx = argv.indexOf('--board-url');
  const boardUrlFlag = flagIdx !== -1 ? argv[flagIdx + 1] : '';
  const positional = argv.filter((a, i) => {
    if (a.startsWith('-')) return false;
    if (flagIdx !== -1 && i === flagIdx + 1) return false;
    return true;
  });
  return { boardUrlFlag, positional };
}

function resolveBoardUrl(boardUrlFlag) {
  const fromEnv = process.env.BOARD_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  if (boardUrlFlag) return String(boardUrlFlag).replace(/\/$/, '');
  // 服务端注入后不再含占位符
  if (EMBEDDED_BOARD_URL && !EMBEDDED_BOARD_URL.includes('__BOARD_URL__')) {
    return EMBEDDED_BOARD_URL.replace(/\/$/, '');
  }
  return '';
}

function ensureSymlink(linkPath, target) {
  if (existsSync(linkPath) || lstatSync(linkPath, { throwIfNoEntry: false })) {
    unlinkSync(linkPath);
  }
  symlinkSync(target, linkPath);
}

function stripBetween(text, begin, end) {
  const start = text.indexOf(begin);
  if (start === -1) return text;
  const endIdx = text.indexOf(end);
  if (endIdx === -1) return text;
  return text.slice(0, start) + text.slice(endIdx + end.length);
}

function patchAgentsFile(repo, bundle, dryRun) {
  const file = join(repo, 'AGENTS.md');
  let existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  existing = stripBetween(existing, bundle.legacyAgentsMarker, bundle.legacyAgentsEnd);

  let next;
  if (existing.includes(bundle.agentsMarker)) {
    const start = existing.indexOf(bundle.agentsMarker);
    const end = existing.indexOf(bundle.agentsEnd);
    if (end === -1) return { action: 'skipped', reason: '标记不完整，需手工处理' };
    next = existing.slice(0, start) + bundle.agentsSection + existing.slice(end + bundle.agentsEnd.length);
    if (next === existing) return { action: 'unchanged' };
    if (!dryRun) writeFileSync(file, next, 'utf8');
    return { action: 'updated' };
  }

  const separator = existing.trim() ? `${existing.trimEnd()}\n\n` : '';
  next = `${separator}${bundle.agentsSection}\n`;
  if (!dryRun) writeFileSync(file, next, 'utf8');
  return { action: existing ? 'appended' : 'created' };
}

/** Claude Code reads CLAUDE.md; import AGENTS.md so rules stay in one place. */
function ensureClaudeMd(repo, bundle, dryRun) {
  const file = join(repo, 'CLAUDE.md');
  if (!existsSync(file)) {
    if (!dryRun) writeFileSync(file, '@AGENTS.md\n', 'utf8');
    return { action: 'created', reason: 'import AGENTS.md' };
  }

  const existing = readFileSync(file, 'utf8');
  if (/(^|\n)@AGENTS\.md\b/.test(existing)) {
    return { action: 'unchanged', reason: 'already imports AGENTS.md' };
  }
  if (bundle.agentsMarker && existing.includes(bundle.agentsMarker)) {
    return { action: 'unchanged', reason: 'has autoboard section' };
  }

  const next = `@AGENTS.md\n\n${existing.replace(/^\uFEFF/, '')}`;
  if (!dryRun) writeFileSync(file, next, 'utf8');
  return { action: 'updated', reason: 'prepended @AGENTS.md' };
}

function removeLegacySkillDirs(repo, legacyNames, dryRun) {
  const names = Array.isArray(legacyNames) ? legacyNames : legacyNames ? [legacyNames] : [];
  for (const root of [
    join(repo, '.cursor', 'skills'),
    join(repo, '.codex', 'skills'),
    join(repo, '.claude', 'skills'),
  ]) {
    for (const name of names) {
      const legacy = join(root, name);
      if (!existsSync(legacy) && !lstatSync(legacy, { throwIfNoEntry: false })) continue;
      if (!dryRun) rmSync(legacy, { recursive: true, force: true });
    }
  }
}

function install(repo, bundle, dryRun) {
  const skillName = bundle.skillName;
  const cursorDir = join(repo, '.cursor', 'skills', skillName);
  const linkTarget = join('..', '..', '..', '.cursor', 'skills', skillName, 'SKILL.md');
  const linkRoots = [
    join(repo, '.codex', 'skills', skillName),
    join(repo, '.claude', 'skills', skillName),
  ];

  if (!dryRun) {
    const legacyNames = bundle.legacySkillNames || bundle.legacySkillName;
    removeLegacySkillDirs(repo, legacyNames, dryRun);
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(join(cursorDir, 'SKILL.md'), bundle.skillMd, 'utf8');
    for (const dir of linkRoots) {
      mkdirSync(dir, { recursive: true });
      ensureSymlink(join(dir, 'SKILL.md'), linkTarget);
    }
  }

  const agents = patchAgentsFile(repo, bundle, dryRun);
  const claude = ensureClaudeMd(repo, bundle, dryRun);
  return { agents, claude };
}

function askYes(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveAsk) => {
    rl.question(question, (answer) => {
      rl.close();
      resolveAsk(/^(y|yes)$/i.test(String(answer).trim()));
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--check');
  const autoYes = argv.includes('--yes') || argv.includes('-y');
  const { boardUrlFlag, positional } = parseArgs(argv);
  const boardUrl = resolveBoardUrl(boardUrlFlag);
  const repo = resolve(positional[0] || process.cwd());

  if (!boardUrl) {
    console.error('缺少 BOARD_URL。请设置环境变量，或从看板复制一键安装命令。');
    process.exit(1);
  }

  if (!existsSync(join(repo, '.git'))) {
    console.error(`不是 git 仓库：${repo}`);
    process.exit(1);
  }

  const label = repo.replace(homedir(), '~');

  console.log(`看板：${boardUrl}`);
  console.log(`目标：${label}`);

  let bundle;
  try {
    const res = await fetch(`${boardUrl}/api/install-bundle`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bundle = await res.json();
    if (!bundle?.skillMd || !bundle?.agentsSection) throw new Error('install-bundle 响应缺少字段');
  } catch (err) {
    console.error(`拉取安装包失败：${err.message}`);
    process.exit(1);
  }

  const skillName = bundle.skillName || 'autoboard-report';
  const paths = [
    `.cursor/skills/${skillName}/SKILL.md`,
    `.codex/skills/${skillName}/SKILL.md`,
    `.claude/skills/${skillName}/SKILL.md`,
    `AGENTS.md`,
    `CLAUDE.md`,
  ];
  console.log('将写入：');
  for (const p of paths) console.log(`  ${p}`);

  if (!dryRun && !autoYes) {
    if (!process.stdin.isTTY) {
      console.error('管道安装请加 --yes，例如：curl -fsSL "$BOARD_URL/install.mjs" | node --input-type=module - --yes');
      process.exit(1);
    }
    const ok = await askYes('确认写入？[y/N] ');
    if (!ok) {
      console.log('已取消');
      process.exit(0);
    }
  }

  const { agents, claude } = install(repo, bundle, dryRun);
  console.log(
    `${dryRun ? '[检查]' : '[已装]'} ${label}  技能✓  .codex/.claude 软链✓  AGENTS.md ${agents.action}${agents.reason ? `（${agents.reason}）` : ''}  CLAUDE.md ${claude.action}${claude.reason ? `（${claude.reason}）` : ''}`,
  );
  if (!dryRun) {
    console.log('\n请把上述文件提交到本仓库，同事拉取后 agent 会按规则上报到同一看板。');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
