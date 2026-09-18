---
name: AutoBoard上报
description: >-
  把当前对话正在处理的线上问题排查、bug 或需求上报到 AutoBoard 自动看板。当你开始或结束排查线上问题、
  登记新的 bug/需求、确认要不要做、定位缺陷、开发功能、修复问题、推进需求、变更任务状态，
  或用户询问看板/进展时使用。每轮实质性工作结束前都应上报一次。
---

# AutoBoard上报

AutoBoard（自动看板）https://autoboard.html-js.com 收集「每个项目当前在排查哪些线上问题、在做哪些 bug/需求、什么状态、
最后一次进展是什么」。你在任何项目里做实质性工作时都要上报，这样其他人不用问就能看到进展。

**上报方式就是一个 HTTP POST，不依赖任何本地脚本或本机路径**，任何人、任何机器、任何 agent
都是同一条命令。

看板上有四类工作，**排查线上问题和 bug、需求是平级的**：

- `incident` 线上问题排查：还没定性成缺陷，但有人正在查。看板实时显示「谁在排查什么、已经查了多久」
- `bug` 缺陷
- `feature` 需求
- `chore` 杂项（重构、文档、测试、依赖升级）

**提出 ≠ 要做**。bug 可能是误报、需求可能被砍，所以「确认」是独立于开发的一个阶段：
新登记的东西先进 `pending`（待确认），有人拍板要做才进 `confirmed`，不做就进 `rejected`。
不要一登记就写 `in_progress`，那会让别人以为已经有人在动手。

## 一、开始排查线上问题 / 结束排查

排查是一段有始有终的过程，**开始和结束都要单独上报一次**，看板据此算出排查耗时。

```bash
# 开始排查：一接到线上反馈就报，不要等查清楚
curl -s -X POST https://autoboard.html-js.com/api/report -H 'content-type: application/json' -d '{
  "project": "yuce-gpt", "actor": "张三", "agent": "cursor", "branch": "develop/sprint-26",
  "kind": "incident", "event": "start",
  "title": "线上 SSE 长对话断流",
  "progress": "客服反馈 3 个租户复现，正在看网关与 nginx 日志"
}'

# 结束排查：title 必须与开始时一字不差，否则算不出耗时
curl -s -X POST https://autoboard.html-js.com/api/report -H 'content-type: application/json' -d '{
  "project": "yuce-gpt", "actor": "张三", "agent": "cursor",
  "event": "end", "status": "done",
  "title": "线上 SSE 长对话断流",
  "progress": "确认是 nginx proxy_read_timeout 60s 截断，已调到 600s 并验证"
}'
```

结束排查时**必须**想清楚落到哪个状态，排查结论就体现在这里：

- 查清楚且已修复 → `"status": "done"`
- 已定位原因，确认要修但还没开工 → `"kind": "bug", "status": "confirmed"`
- 已定位原因，接着就动手修 → `"kind": "bug", "status": "in_progress"`
- 查下来不是问题（误报、用户操作、重复单） → `"status": "rejected"`，结论写进 `progress`
- 卡在外部依赖（等运维、等三方） → `"status": "blocked"`
- 暂时查不下去、需要更多现场 → `"status": "pending"`

中途有关键线索但还没结束，就报一条普通进展（不带 `event`），不要重复发 `start`。
重复 `start` 不会清零已排查时长，会沿用最早的开始时间；没配对 `start` 的 `end` 只记事件、不编造耗时。

## 二、上报 bug / 需求进展

**要上报**：新收到一个 bug/需求（先登记成 `pending`）、确认要不要做、定位到缺陷原因、
开始或推进一个需求、完成修复、提交评审、被外部依赖卡住、状态发生变化、
一轮对话里产出了实质进展。

**不要上报**：纯粹的信息查询、只读代码浏览、用户只是问问题没有推进工作、
本轮没有任何进展变化（避免刷屏）。

```bash
# 刚收到，还没人拍板做不做
curl -s -X POST https://autoboard.html-js.com/api/report -H 'content-type: application/json' -d '{
  "project": "yuce-gpt", "actor": "张三", "agent": "cursor",
  "kind": "feature", "status": "pending",
  "title": "会话列表支持按智能体筛选",
  "progress": "业务同学提的，还没评估工作量，等产品确认是否本迭代做"
}'

# 确认要做但还没开工（同一个标题，命中同一条目）
curl -s -X POST https://autoboard.html-js.com/api/report -H 'content-type: application/json' -d '{
  "project": "yuce-gpt", "actor": "张三", "agent": "cursor",
  "status": "confirmed",
  "title": "会话列表支持按智能体筛选",
  "progress": "产品确认排进 sprint-26，方案走前端本地筛选，不改接口"
}'

# 开工后的常规进展上报
curl -s -X POST https://autoboard.html-js.com/api/report -H 'content-type: application/json' -d '{
  "project": "yuce-gpt", "actor": "张三", "agent": "cursor", "branch": "develop/sprint-26",
  "kind": "bug", "status": "in_progress",
  "title": "SSE 断流后会话卡住",
  "progress": "已定位到 compress 分支未回收 run tree，正在改 fire_and_forget",
  "refs": ["https://devops.aliyun.com/workitem/xxx"]
}'
```

返回 `{"ok":true,"items":[{"id":"BUG-20260917-001","action":"created",...}]}` 即成功。
连不上看板就跳过，不要因为上报失败中断手上的工作。

## 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `project` | 是 | 当前仓库目录名，如 `yuce-gpt`。传绝对路径也行，服务会自动取最后一段 |
| `title` | 是 | 一句话说清是什么问题/需求。**同一件事必须每次用完全相同的标题**，看板靠标题归一化去重 |
| `progress` | 是 | 本轮进展，简体中文一句话，写「做了什么 / 卡在哪」而不是「我在处理这个问题」 |
| `actor` | 强烈建议 | 负责人。不知道就先跑 `git config user.name`，缺省会记成 `unknown` |
| `agent` | 否 | `cursor` \| `codex` \| `claude`，填你自己所处的工具 |
| `kind` | 否 | `incident` \| `bug` \| `feature` \| `chore`，默认 `feature` |
| `status` | 否 | 见下表七个值。新建不传默认 `pending`；更新时不传则**保持原状态**，只想追加进展就别带 |
| `event` | 否 | 只在排查时用：`start` 开始排查 / `end` 结束排查。普通进展不要带 |
| `branch` | 否 | 当前分支，`git rev-parse --abbrev-ref HEAD` |
| `id` | 否 | 已知条目 ID（如 `INC-20260917-001`）时传入，**优先于标题匹配** |
| `refs` | 否 | 相关链接数组，如云效工作项、PR 地址 |

### 状态只能取这七个值

| 状态 | 含义 | 什么时候用 |
|---|---|---|
| `pending` | 待确认 | 刚提出/刚登记，还没定是不是真问题、要不要做、谁来做 |
| `confirmed` | 已确认待开工 | 拍板要做了，已排期但还没动手 |
| `in_progress` | 开发中 | 真的在写代码/改配置了 |
| `review` | 待评审/待验证 | 代码写完等 review，或改完等测试/业务验证 |
| `blocked` | 被卡住 | 等外部依赖、等决策、等他人，自己推不动 |
| `done` | 已完成 | 做完并验证通过 |
| `rejected` | 不做 | 误报、重复、无需处理、被砍掉。**和 `done` 严格区分** |

`pending → confirmed → in_progress → review → done` 是主干，`rejected` 可以从任何阶段进入。
从 `pending` 直接跳 `in_progress` 只在「自己发现自己当场就修」时才合理，其余情况请留下确认这一步。

不要发明 `MERGED_TEST04_E2E` 这类自由文本状态。交付细节（合到哪个环境、哪个 commit）写进 `progress`。
状态变更的理由也写进 `progress`：拍板/否决的依据比状态本身更重要。

「正在排查」不是状态，而是由 `event` 维护的一段区间，和状态互不冲突：
一个条目可以处于 `in_progress` 并且同时「排查中」，也可以结束排查后仍留在 `in_progress`。

## 关键约束：不要制造重复条目

看板按 `项目 + 条目 ID` 或 `项目 + 归一化标题` 做幂等 upsert。所以：

- 同一件事的后续上报，**标题保持一字不变**，或直接带上首次返回的 `id`。
- 首次上报返回 `"action":"created"` 并给出 ID，把它记住，本轮对话后续上报都带 `id`。
- `end` 必须命中 `start` 建的那个条目，否则算不出耗时——所以标题一字不改，或者直接用 `id`。
- 看到 `"action":"updated"` 说明命中了已有条目，这是**正确**行为，不要改标题重试。
- 一轮对话里同一条目只上报一次，不要每改一个文件就报一次。

## 查看看板

页面 https://autoboard.html-js.com ，全量 JSON：

```bash
curl -s https://autoboard.html-js.com/api/board
```

## 附：本地 CLI（可选）

如果你这台机器上 clone 了 `autoboard` 仓库（目录名也可能仍是 `team-board`），可以在它的目录下用 CLI 代替 curl，好处是
`project` / `branch` / `actor` 自动从 git 推导，不用手填：

```bash
node bin/board-report.mjs start --title "线上问题一句话" --progress "现象与线索"
node bin/board-report.mjs end   --title "同一个标题" --status done --progress "结论"
node bin/board-report.mjs item  --kind bug --title "..." --progress "..."
```

**没有这个仓库就用上面的 curl，两者完全等价**，不要为了用 CLI 去 clone 仓库。
