# AutoBoard

自托管看板，面向 AI Agent（Cursor / Codex）：汇总各项目正在排查的线上问题、缺陷与需求——状态与最新进展一页看清。

要求 Node >= 22。零运行时依赖。

> 公开演示（只读预览）：https://autoboard.html-js.com  
> **不要**把团队上报指向该地址。请自行部署实例，并向你自己的 URL 上报。

英文版：[README.md](./README.md)

理念与最佳实践：[docs/philosophy.zh-CN.md](./docs/philosophy.zh-CN.md) · [English](./docs/philosophy.md)

## 1. 部署看板

### Docker（推荐）

```bash
git clone <this-repo-url> autoboard && cd autoboard
docker compose up -d --build
curl -s http://127.0.0.1:7788/api/health
# UI: http://<host-ip>:7788
```

可在 `docker-compose.yml` 同目录放置可选 `.env`：

```bash
BOARD_PORT=7788
BOARD_TOKEN=your-secret   # 可选；设置后写接口需要 Authorization: Bearer <token>
BOARD_DATA_DIR=./data
BOARD_TITLE=Acme Board    # 可选；浏览器标签与页头品牌名
BOARD_ICON=/favicon.svg   # 可选；favicon URL（可挂载自定义文件覆盖）
```

数据保存在宿主机 `./data`。只运行 **单个** 副本。

自定义 favicon：放置 `./brand/favicon.svg`，并取消 `docker-compose.yml` 中对应 volume 的注释。

```bash
docker compose logs -f
docker compose restart
docker compose down       # 保留 ./data
```

### 本地（开发）

```bash
npm start                 # http://127.0.0.1:7788
```

| 变量 | 默认值 | 含义 |
|---|---|---|
| `BOARD_PORT` | `7788` | 端口 |
| `BOARD_HOST` | `127.0.0.1` | 监听地址（Docker 内为 `0.0.0.0`） |
| `BOARD_TOKEN` | 空 | 若设置，写接口需要 `Authorization: Bearer <token>` |
| `BOARD_DATA_DIR` | `./data` | 数据目录 |
| `BOARD_PUBLIC_URL` | 空 | 对外基址，用于 `/install.mjs` 内嵌 URL（反代场景） |
| `BOARD_TITLE` | `AutoBoard` | 浏览器标签标题与页头品牌文案 |
| `BOARD_ICON` | `/favicon.svg` | Favicon URL（相对路径或绝对 URL） |

需要 HTTPS / 公网域名时，前面加 nginx（或同类）反代。Agent 上报指向该对外 URL。

接口：`POST /api/report` · `POST /api/ping` · `GET /api/board` · `GET /api/health` · `GET /api/install-bundle` · `GET /install.mjs` · `GET /`（UI）

快捷键：`/` 过滤 · `j`/`k` 移动 · `Enter` 展开时间线 · `Esc` 清空过滤

## 2. 向看板上报

将 `https://board.example.com` 换成 **你自己** 部署的地址。

```bash
curl -s -X POST https://board.example.com/api/report -H 'content-type: application/json' -d '{
  "project": "my-app", "actor": "alice", "agent": "cursor", "branch": "main",
  "kind": "bug", "status": "in_progress",
  "title": "Session stuck after SSE disconnect",
  "progress": "Located unreclaimed run tree; fixing fire_and_forget"
}'
```

仅 `project` 与 `title` 必填。后续更新请复用同一 `title`（或首次返回的 `id`），才会落到同一行。

批量用 `items`：

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

### 字段

| 字段 | 取值 |
|---|---|
| `kind` | `incident` · `bug` · `feature` · `chore` |
| `status` | `pending` → `confirmed` → `in_progress` → `review` → `done` · 另有 `blocked` · `rejected` |
| `event` | 普通进展可省略 · 线上排查计时用 `start` / `end` |

- 新条目默认 `pending`。更新时省略 `status` 则保持当前状态。

### 线上排查开始 / 结束

```bash
# 开始
curl -s -X POST https://board.example.com/api/report -H 'content-type: application/json' -d '{
  "project": "my-app", "actor": "alice", "agent": "cursor",
  "kind": "incident", "event": "start",
  "title": "Production SSE long-chat disconnect",
  "progress": "Support reports 3 tenants reproducing"
}'

# 结束 — title 必须与开始时完全一致
curl -s -X POST https://board.example.com/api/report -H 'content-type: application/json' -d '{
  "project": "my-app", "actor": "alice", "agent": "cursor",
  "event": "end", "status": "done",
  "title": "Production SSE long-chat disconnect",
  "progress": "nginx proxy_read_timeout was cutting the stream"
}'
```

### CLI（可选）

会从 git 自动填充 `project` / `branch` / `actor`。务必把 `BOARD_URL` 设成你的实例：

```bash
export BOARD_URL=https://board.example.com

node bin/board-report.mjs start --title "..." --progress "..."
node bin/board-report.mjs end   --title "..." --status done --progress "..."
node bin/board-report.mjs item  --kind bug --title "..." --status in_progress --progress "..."
```

## 3. 安装到业务仓库

**推荐** — 在需要向 **你的** 看板上报的项目 git 根目录执行（不必克隆本仓库）：

```bash
curl -fsSL "https://board.example.com/install.mjs" | node --input-type=module - --yes
```

或打开看板 UI → **安装到项目** → 复制命令（会使用当前访问的 origin）。

会写入：

- `.cursor/skills/AutoBoard上报/SKILL.md`
- `.codex/skills/…` 与 `.claude/skills/…` 指向该文件的符号链接
- `AGENTS.md` 中一段说明（标记 `<!-- autoboard:begin/end -->`）

把这些文件提交进仓库，队友就会共用同一个看板 URL。

### 维护者 / 离线（已克隆本仓库）

```bash
# 当前目录
BOARD_URL=https://board.example.com node bin/install-agents.mjs

# 指定路径 / 扫描根目录
BOARD_URL=https://board.example.com node bin/install-agents.mjs ~/code/my-app
BOARD_SCAN_ROOT=~/code BOARD_URL=https://board.example.com node bin/install-agents.mjs --all
BOARD_URL=https://board.example.com node bin/install-agents.mjs --check .
```

服务端可选设置 `BOARD_PUBLIC_URL`：在反代场景下，强制 `/install.mjs` 与 `/api/install-bundle` 内嵌的对外 URL。
