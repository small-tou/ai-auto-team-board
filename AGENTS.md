# AutoBoard Development Notes

Auto board service: AI agents automatically record progress across projects. Zero runtime dependencies, Node >= 22. Read `README.md` before making changes.

## Layout

| Path | Role |
|---|---|
| `src/server.mjs` | HTTP entry and routes; listens on loopback only |
| `src/store.mjs` | Append-only event log, in-memory projection, idempotent upsert, timeline |
| `src/schema.mjs` | `kind` / `status` enums and input normalization |
| `src/install-assets.mjs` | Skill / AGENTS.md render + install-into-repo helpers |
| `src/remote-install.mjs` | Standalone installer served as `GET /install.mjs` |
| `public/index.html` | Single-file board UI; no framework, no build step |
| `bin/board-report.mjs` | Unified report entry; hook and CLI dual mode |
| `bin/install-agents.mjs` | Local installer into target repos (default: cwd) |
| `skills/autoboard-report/SKILL.md` | Skill body template; `<BOARD_URL>` replaced on install |

## Hard Constraints

- **English only for comments and docs**: all code comments and project documentation written during development must be in English (including README, AGENTS.md, skills, and inline notes). Do not leave Chinese comments or docs in the repo.
- **Zero runtime dependencies**: do not add npm packages. Prefer Node built-ins for new capabilities.
- **Report script must never block the conversation**: every path in `bin/board-report.mjs` must `exit 0`; hook mode must emit valid JSON. Do not introduce uncaught exceptions or long-blocking logic in this file.
- **Status enum has only five values**: `open` / `in_progress` / `review` / `blocked` / `done`. Before adding a status, ask whether it belongs in `progress` instead — one reason this project exists is to replace free-text status columns.
- **Event log is append-only**: `data/events.jsonl` is append-only, never rewritten. Skip bad lines on replay; a corrupt line must not prevent startup.
- **Protocol changes must stay in sync in three places**: `src/schema.mjs`, `skills/autoboard-report/SKILL.md`, and `renderAgentsSection` in `src/install-assets.mjs`. Otherwise installed repos drift from the server. After changes, re-run `install-agents.mjs` or the board’s `/install.mjs` to refresh repos.

## Local Verification

```bash
npm start
curl -s http://127.0.0.1:7788/api/health
node bin/board-report.mjs item --kind chore --title "verify report" --status done --progress "ok"
curl -s http://127.0.0.1:7788/api/board
```

Hook mode can be verified by feeding a payload:

```bash
echo '{"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":"'$PWD'"}' | node bin/board-report.mjs hook
```

<!-- autoboard:begin -->
## AutoBoard Reporting (required)

Incidents, bugs, and feature progress for this project must be reported to the AutoBoard at https://autoboard.html-js.com. Every agent (Cursor / Codex / Claude) must follow this. **POST directly to that URL; do not depend on any local script or machine path.**

**Prefer English** for `title` and `progress` (and other free-text fields) so the board stays readable across the team.

**When to report**: start/end of incident investigation, register a new bug/feature, decide whether to do it, find a root cause, advance or finish work, submit for review, get blocked, or change status. Pure queries and read-only browsing do not need a report.

**Bug / feature progress** (once before ending each substantive work turn):

```bash
curl -s -X POST https://autoboard.html-js.com/api/report -H 'content-type: application/json' -d '{
  "project": "<current repo directory name>", "actor": "<git config user.name>", "agent": "cursor",
  "kind": "bug", "status": "in_progress",
  "title": "One-sentence description of the issue", "progress": "What was done this turn / where blocked"
}'
```

**Filed ≠ committed to do**: newly received bugs/features that are not yet decided use `"status": "pending"`; confirmed but not started use `"confirmed"`; explicitly not doing (false positive / duplicate / cut) use `"rejected"` and put the reason in `progress`. Do not register as `in_progress` immediately — that makes others think work has already started.

**Incident investigation** (same level as bugs/features; report once at start and once at end so the board can compute time spent):

```bash
# Start: report as soon as production feedback arrives; do not wait for a root cause
curl -s -X POST https://autoboard.html-js.com/api/report -H 'content-type: application/json' -d '{
  "project": "<repo directory name>", "actor": "<your name>", "agent": "cursor",
  "kind": "incident", "event": "start",
  "title": "One-sentence production issue", "progress": "Symptoms and current leads"
}'

# End: title must match the start report exactly, or duration cannot be computed
curl -s -X POST https://autoboard.html-js.com/api/report -H 'content-type: application/json' -d '{
  "project": "<repo directory name>", "actor": "<your name>", "agent": "cursor",
  "event": "end", "status": "done",
  "title": "One-sentence production issue", "progress": "Root cause and conclusion"
}'
```

- `kind`: `incident` (production investigation) | `bug` | `feature` | `chore`
- `status`: `pending` (to confirm) | `confirmed` (confirmed, not started) | `in_progress` | `review` (awaiting review/verification) | `blocked` | `done` | `rejected` (will not do) — **only these seven values**; delivery details and decision rationale go in `progress`
- Omitting `status` on update keeps the previous status; when only appending progress, do not send a status by accident
- `event`: only for investigations — `start` / `end`; do not send on ordinary progress updates
- `project` is the current repo directory name; if `actor` is unknown, run `git config user.name`; optional `"branch"` and `"refs": ["url"]`
- **Follow-ups for the same item must reuse the exact same `title`, or include the `id` from the first response**, or you get duplicates and `end` cannot compute duration
- `{"ok":true,...}` means success; if the board is unreachable, skip and do not block the current work

See skill `autoboard-report` for details.
<!-- autoboard:end -->
