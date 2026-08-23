<div align="center">

<img src="packages/desktop/assets/app-icon.svg" alt="Strado" width="96" />

### One place to run all your coding agents

[![CI](https://github.com/strado-io/strado/actions/workflows/ci.yml/badge.svg)](https://github.com/strado-io/strado/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/strado-io/strado?style=flat&logo=github)](https://github.com/strado-io/strado/stargazers)
[![X](https://img.shields.io/badge/@strado__io-555?logo=x)](https://x.com/strado_io)

Run Claude Code, Codex, and opencode in parallel — each in its own git worktree.<br />
Debug in the built-in browser, edit in the built-in IDE, and verify every change while you steer.

[**Download**](https://strado.io) &nbsp;&bull;&nbsp; [Build from source](BUILDING.md) &nbsp;&bull;&nbsp; [Contributing](CONTRIBUTING.md)
<!-- hero clip: drop docs/assets/readme/hero.gif here (ptyd survive-restart or parallel-agents recording)
<img width="full" alt="Parallel agents working across Strado worktrees" src="docs/assets/readme/hero.gif" />
-->
</div>

## Review proof, not promises

Strado gives every git worktree its own persistent agent sessions, terminals,
embedded IDE, and an embedded browser. Agents get scoped browser access to
their own worktree's preview — so you watch the change working instead of
trusting the summary.

- **Run agents in parallel** — each task isolated in its own worktree, branch, and environment
- **Verify while you steer** — the built-in browser is scoped per worktree; agents prove their work in it
- **Edit where agents work** — built-in IDE and terminals live next to every session
- **Sessions survive everything** — closing the tab, restarting the app, even app updates
- **Review fast** — per-hunk stage/discard, commit graph, push/pull, MR creation
- **Time tracking that doesn't lie** — hands-on time from real signals, no timers to start

Everything runs on your machine. The optional Strado Cloud account adds
hosted relay, remote runners, and org features — the app never requires it.

## Features

<table>
<tr>
<td width="50%" valign="middle">

### Worktrees as first-class citizens

Create, adopt, and delete worktrees across multiple repos and workspaces —
with `node_modules` linking and dev-server start/stop built in. Each row shows
branch, uncommitted changes, env profile, and run status live.

</td>
<td width="50%">
<!-- docs/assets/readme/worktrees.png -->
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Agent & terminal hub

Persistent Claude Code, Codex, opencode, and shell sessions per worktree —
they survive closing the tab and app updates. One hub window with a super-tab
per worktree, plus the embedded IDE.

</td>
<td width="50%">
<!-- docs/assets/readme/hub.png -->
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Verify in the built-in browser

Every worktree's preview opens in an embedded browser, and agents get scoped
DevTools access to their own preview only. Watch the fix render instead of
reading about it.

</td>
<td width="50%">
<!-- docs/assets/readme/browser.png -->
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Diff, commit, ship

Staged/unstaged hunks, stage or discard per hunk, commit graph, push/pull,
and MR creation. Arrow keys walk the file list.

</td>
<td width="50%">
<!-- docs/assets/readme/diff.png -->
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Jira, live — and honest time tracking

Ticket badges tinted by real Jira status, sprint-scoped pickers, one-click
sprint import that scaffolds worktrees from tickets. Hands-on time per
worktree measured from real signals (keystrokes, agent turns, file saves),
sessionized with a 15-minute idle gap — no timers, no worklogs to remember.

</td>
<td width="50%">
<!-- docs/assets/readme/jira.png -->
</td>
</tr>
</table>

## Requirements

- Node 20+, git 2.40+
- Worktrees live under `~/.strado/worktrees/<repoId>` (created automatically
  for new worktrees).

## Quick start

See [BUILDING.md](BUILDING.md).

### Two instances side by side

The installed app and a build from this repo run at the same time without
touching each other. Which one you get is decided by `STRADO_PROFILE`, and the
repo's own scripts set it for you.

| | stable | dev |
|---|---|---|
| How it runs | the installed app | `npm run desktop` / `npm start` |
| State | `~/.strado` | `~/.strado-dev` |
| HTTP | 7777 | 7877 |
| CDP (preview MCP) | 9222 | 9322 |
| Name | Strado | Strado Dev |

The dev profile starts empty — add your repos to it once. To point a repo build
at your real state instead (to reproduce something against real worktrees), quit
the installed app first and run `STRADO_PROFILE=stable npm run desktop`.

`STRADO_HOME`, `STRADO_CONFIG_DIR`, `PORT` and `STRADO_CDP_PORT` still override
the profile individually.

**The profile comes from the npm scripts, not from detection.** Running
`electron .` directly inside `packages/desktop` bypasses them, so
`STRADO_PROFILE` is unset and you get **stable** — `~/.strado`, port 7777, CDP
9222 — which will collide with a genuinely installed Strado if both are running.
Use `npm run desktop`. The default is `stable` on purpose: the server also runs
headless on runners, which must keep using `~/.strado`.

**Frontend work.** `npm run dev` runs the dev-profile server on 7877 and vite on
**7778** — vite has always owned 7778, which is why the dev profile is 7877.
Vite's proxy target follows `STRADO_SERVER_PORT` (default 7777), and `dev:web`
sets it to 7877, so the dev frontend talks to the dev server. Running vite bare
still targets the stable instance.

The dev window title reads **Strado Dev** (the renderer learns the profile from
`/api/capabilities`). Electron's own state is separate too:
`~/Library/Application Support/Strado Dev` and `~/Library/Logs/Strado Dev`.

## Jira

Sidebar → **Jira Connection**: site URL, account email, and an API token
(create one at id.atlassian.com → Security → API tokens). Credentials are
validated against Jira, stored at `~/.strado/jira.json` (mode 600), and never
sent to the browser — the local server proxies all Jira calls.

## Where things live

| Path | What |
| --- | --- |
| `config/workspaces.json` | workspace registry (active workspace, identities) |
| `config/workspaces/<id>/` | per-workspace repos + worktree state |
| `config/**/.backups/` | rotating backups of every store (automatic) |
| `~/.strado/jira.json` | Jira credentials (machine-local) |
| `~/.strado/activity.json` | tracked time per worktree |
| `~/.strado/logs/` | dev-server logs |

`config/` is gitignored; `config.example/` documents the layout.

## Development

```sh
npm run dev        # tsx server + vite web with HMR
npm test           # server + web test suites
```

The production server serves the built `packages/web/dist`; after web changes
run `npm run build -w packages/web` and reload.

### Terminal daemon

Terminal sessions (Claude/Codex/OpenCode/shell PTYs) are owned by a small
standalone daemon, `strado-ptyd` (`packages/ptyd`), reached over a Unix
socket at `~/.strado/ptyd/ptyd.sock`. The daemon runs from `~/.strado/ptyd/bin/` (installed at boot from the app bundle), with logs at `~/.strado/ptyd/ptyd.log`. The server is just a client — restarting
or updating the server (or the whole app) leaves sessions running, and the
server reattaches on boot. Daemon upgrades hand live sessions off to the new binary (fd handoff) — an app update never kills a running agent. To force the
old in-process PTYs (tests / break-glass): `STRADO_INPROC_PTY=1`.

## Packages

- `packages/server` — Fastify API: worktree/git ops, pty sessions, process
  manager, Jira proxy, activity tracker, VS Code web
- `packages/web` — React + Tailwind dashboard
- `packages/desktop` — Electron shell (spawns/reuses the server)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions are accepted under the
MIT license with DCO sign-off (`git commit -s`).

## License

MIT — see [LICENSE](LICENSE). "Strado" and the Strado logo are trademarks of
the Strado team; the license covers the code, not the name.
