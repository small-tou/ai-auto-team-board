# AutoBoard

Self-hosted board for AI agents (Cursor / Codex): track which incidents, bugs, and features are in flight across your projects — status and latest progress on one page.

Requires Node >= 22. Zero runtime dependencies.

中文说明：[README.zh-CN.md](./README.zh-CN.md)

Philosophy & best practices: [docs/philosophy.md](./docs/philosophy.md) · [中文](./docs/philosophy.zh-CN.md)

> Public demo (read-only peek): https://autoboard.html-js.com  
> Do **not** point your team reports there. Deploy your own instance and report to that URL.

## 1. Deploy your board

### Docker (recommended)

```bash
git clone <this-repo-url> autoboard && cd autoboard
docker compose up -d --build
curl -s http://127.0.0.1:7788/api/health
# UI: http://<host-ip>:7788
```

Optional `.env` next to `docker-compose.yml`:

```bash
BOARD_PORT=7788
BOARD_TOKEN=your-secret   # optional; write APIs then need Authorization: Bearer <token>
BOARD_DATA_DIR=./data
BOARD_TITLE=Acme Board    # optional; browser tab + header brand
BOARD_ICON=/favicon.svg   # optional; favicon URL (mount a custom file to override)
```

Data stays on the host at `./data`. Run a **single** replica only.

To use a custom favicon, place `./brand/favicon.svg` and uncomment the volume mount in `docker-compose.yml`.

```bash
docker compose logs -f
docker compose restart
docker compose down       # keeps ./data
```

### Local (dev)

```bash
npm start                 # http://127.0.0.1:7788
```

| Variable | Default | Meaning |
|---|---|---|
| `BOARD_PORT` | `7788` | Port |
| `BOARD_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` in Docker) |
| `BOARD_TOKEN` | empty | If set, write APIs need `Authorization: Bearer <token>` |
| `BOARD_DATA_DIR` | `./data` | Data directory |
| `BOARD_PUBLIC_URL` | empty | Public base URL for `/install.mjs` embeds (when behind a proxy) |
| `BOARD_TITLE` | `AutoBoard` | Browser tab title and header brand text |
| `BOARD_ICON` | `/favicon.svg` | Favicon URL (relative path or absolute URL) |

Put nginx (or similar) in front if you need HTTPS / a public hostname. Point agents at that URL.

APIs: `POST /api/report` · `POST /api/ping` · `GET /api/board` · `GET /api/health` · `GET /api/install-bundle` · `GET /install.mjs` · `GET /` (UI)

Keyboard: `/` filter · `j`/`k` move · `Enter` expand timeline · `Esc` clear filter

## 2. Report to your board

Replace `https://board.example.com` with **your** deployed URL.

```bash
curl -s -X POST https://board.example.com/api/report -H 'content-type: application/json' -d '{
  "project": "my-app", "actor": "alice", "agent": "cursor", "branch": "main",
  "kind": "bug", "status": "in_progress",
  "title": "Session stuck after SSE disconnect",
  "progress": "Located unreclaimed run tree; fixing fire_and_forget"
}'
```

Only `project` and `title` are required. Reuse the same `title` (or the returned `id`) for follow-ups so the same row is updated.

Batch with `items`:

```json
{
  "project": "my-app",
  "agent": "cursor",
  "actor": "alice",
  "items": [
    { "kind": "bug", "status": "in_progress", "title": "...", "progress": "..." },
    { "kind": "incident", "event": "start", "title": "...", "progress": "..." }
  ]
}
```

### Fields

| Field | Values |
|---|---|
| `kind` | `incident` · `bug` · `feature` · `chore` |
| `status` | `pending` → `confirmed` → `in_progress` → `review` → `done` · also `blocked` · `rejected` |
| `event` | omit for normal progress · `start` / `end` for incident investigation timing |

- New items default to `pending`. Omit `status` on update to keep the current status.

### Incident start / end

```bash
# Start
curl -s -X POST https://board.example.com/api/report -H 'content-type: application/json' -d '{
  "project": "my-app", "actor": "alice", "agent": "cursor",
  "kind": "incident", "event": "start",
  "title": "Production SSE long-chat disconnect",
  "progress": "Support reports 3 tenants reproducing"
}'

# End — title must match start exactly
curl -s -X POST https://board.example.com/api/report -H 'content-type: application/json' -d '{
  "project": "my-app", "actor": "alice", "agent": "cursor",
  "event": "end", "status": "done",
  "title": "Production SSE long-chat disconnect",
  "progress": "nginx proxy_read_timeout was cutting the stream"
}'
```

### CLI (optional)

Auto-fills `project` / `branch` / `actor` from git. Always set `BOARD_URL` to your instance:

```bash
export BOARD_URL=https://board.example.com

node bin/board-report.mjs start --title "..." --progress "..."
node bin/board-report.mjs end   --title "..." --status done --progress "..."
node bin/board-report.mjs item  --kind bug --title "..." --status in_progress --progress "..."
```

## 3. Install into your repos

**Recommended** — in the git root of a project that should report to **your** board (no need to clone this repo):

```bash
curl -fsSL "https://board.example.com/install.mjs" | node --input-type=module - --yes
```

Or open the board UI → **安装到项目** → copy the command (it uses the current origin).

Writes:

- `.cursor/skills/AutoBoard上报/SKILL.md`
- `.codex/skills/…` and `.claude/skills/…` symlinks to that file
- an `AGENTS.md` section (markers `<!-- autoboard:begin/end -->`)

Commit those files so teammates get the same board URL.

### Maintainer / offline (clone of this repo)

```bash
# current directory
BOARD_URL=https://board.example.com node bin/install-agents.mjs

# explicit paths / scan root
BOARD_URL=https://board.example.com node bin/install-agents.mjs ~/code/my-app
BOARD_SCAN_ROOT=~/code BOARD_URL=https://board.example.com node bin/install-agents.mjs --all
BOARD_URL=https://board.example.com node bin/install-agents.mjs --check .
```

`BOARD_PUBLIC_URL` on the server (optional) forces the URL embedded in `/install.mjs` and `/api/install-bundle` when behind a reverse proxy.
