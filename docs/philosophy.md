# AutoBoard: Philosophy and Best Practices

中文版：[philosophy.zh-CN.md](./philosophy.zh-CN.md)

## The problem it solves

AI agents already do real work across repos and sessions. What teams still lack is a reliable answer to:

> Across our projects right now — who is investigating which production issue, which bugs and features are in flight, what status they are in, and what happened in the last meaningful turn?

Traditional boards depend on humans dragging cards. In the agent era, work often finishes inside a chat while the board stays empty. AutoBoard’s scope is narrow and intentional: **agents write progress to one page**, so people can see it without asking.

It is not a project-management suite, not a full ticketing system, and not a chat archive. It answers one question: **what is flying across projects, and what is the latest real progress?**

---

## Core philosophy

### 1. Reporting must stay lightweight and never block work

Reporting is a single HTTP POST. It does not depend on a local script path, a specific machine, or cloning this repo. If the board is unreachable, skip it and keep working.

The report script’s hard rules are: always `exit 0`, never throw uncaught exceptions, never block for long. The board is a **side-channel observation**, not a gate on the main workflow.

### 2. Filed ≠ committed to do

Many systems collapse “registered” and “started” into one step, so everything becomes `in_progress`. AutoBoard keeps confirmation as its own stage:

- `pending` — just filed; not yet decided if it is real or worth doing
- `confirmed` — decided to do it; not started yet
- `in_progress` — actually writing code or changing config
- `rejected` — false positive, duplicate, or cut — strictly distinct from `done`

Registering as `in_progress` immediately makes others think someone is already working.

### 3. Status enums are strict; details go in `progress`

Status values are a fixed set. Free-text statuses (e.g. `MERGED_TEST04_E2E`) are rejected. Which environment, which commit, why something was rejected — all belong in `progress`.

One reason this project exists is to replace unbounded status columns with **a small status set plus readable progress text**.

### 4. Incidents sit at the same level as bugs and features

`incident` is not a secondary tag. Often an issue is not yet a confirmed defect, but “who is investigating what production problem, and for how long” is exactly what a board should surface.

Investigations use `event: start` / `end` for a timed interval, orthogonal to `status`: an item can be `in_progress` and investigating at the same time, or leave investigation while still `in_progress`.

### 5. Idempotent upsert; the title is the identity

The same work item is matched by `project + id` or `project + normalized title`. Follow-ups must **reuse the exact same title**, or include the `id` from the first response. Changing the title and retrying creates duplicates and breaks `end` duration calculation.

### 6. Events are append-only; history is not rewritten

The store is an append-only `events.jsonl`. Corrupt lines are skipped so startup is never blocked. The UI is a projection; the event log is the source of truth — a fit for high-frequency, occasionally messy agent reports.

### 7. Zero dependencies, self-hosted, protocol kept in sync

Zero runtime npm dependencies, a single-file UI, Docker with a single replica. Protocol changes must update schema, the Skill template, and the installed `AGENTS.md` section together, or installed repos drift.

The public demo is for a read-only peek only. **Teams should deploy their own instance and report to that URL.**

---

## Best practices

### Deploy

1. Prefer Docker; keep data on the host under `./data`; run a **single** replica.
2. Put a reverse proxy in front for HTTPS / a public hostname; set `BOARD_PUBLIC_URL` so `/install.mjs` embeds the external URL.
3. Prefer setting `BOARD_TOKEN` for write APIs; agents send `Authorization: Bearer …`.
4. Do not send production team reports to the public demo.

### Install into product repos

From the git root of a product repo (no need to clone this repo), run the install command and **commit** the Skill plus the `AGENTS.md` section so every teammate and every agent shares the same board URL.

After a protocol upgrade, re-run install on product repos so Skills stay aligned with the server enums.

### When to report / when not to

**Report when:** starting or ending an incident investigation; filing a new bug/feature; deciding whether to do it; finding a root cause; advancing or finishing work; submitting for review; getting blocked; changing status; producing substantive progress in a turn.

**Do not report when:** pure Q&A, read-only browsing, or a turn with no progress change. Report once per item per conversation turn — do not spam.

### How to write fields

| Field | Practice |
|---|---|
| `title` | One sentence naming the issue/feature; reuse the exact same title for the same item |
| `progress` | Say what you did / where you are stuck — not “I am working on this” |
| `status` | New items default to `pending`; omit `status` on updates that only append progress |
| `event` | Only for investigations: `start` / `end`; omit on normal progress |
| `id` | Remember the first response `id` and prefer it on follow-ups |
| `actor` | Use `git config user.name`; avoid long-lived `unknown` |

Main path: `pending → confirmed → in_progress → review → done`. `rejected` can be entered from any stage. Jumping from `pending` straight to `in_progress` is only reasonable when you found it and are fixing it immediately.

### Investigation timing

Send `start` as soon as production feedback arrives — do not wait for a root cause. On `end`, the `title` must match the start exactly; put the conclusion in `progress` and land on the right status (fixed / convert to bug / false alarm / blocked, etc.). Mid-investigation clues are normal progress updates — do not repeat `start`.

### Habits for agents

1. Report once before ending a substantive work turn, not after every file edit.
2. If reporting fails, do not retry in a way that interrupts the main task.
3. Prefer a shared language for `title` / `progress` so the board stays readable across the team.
4. The CLI is only a convenience wrapper around curl; without this repo, use curl — they are equivalent.

---

## Common anti-patterns

1. **Registering as `in_progress` immediately** — loses “to confirm / confirmed not started”.
2. **Changing the title on every update** — duplicates rows and breaks investigation duration.
3. **Stuffing delivery detail into `status`** — enum explosion; filters and collaboration break.
4. **Writing `done` for “won’t do”** — conflates completion with rejection.
5. **Blocking the conversation on reporting** — violates the side-channel rule.
6. **Installing the Skill without committing it** — teammates’ agents still point at the wrong board (or none).
7. **Multiple replicas writing the same data directory** — conflicts with single-replica append-only design.

---

## In one sentence

After agents become primary executors, the collaboration bottleneck is less “can we write the code” and more “can others see what you are doing without asking.”

AutoBoard uses a minimal report protocol, a strict status discipline, and a clear split between filing and starting work to fold progress scattered across chats into one trustworthy live projection — **agents keep the ledger; people decide and sync.**
