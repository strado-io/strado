# Config layout

Live config is machine-local and gitignored. On first run the server seeds
`config/` next to its working directory; the easiest setup is the in-app
onboarding (paste a repo path → everything is detected). To hand-configure
instead, copy this directory:

```
cp -R config.example config
```

- `workspaces.json` — workspace registry + active workspace
- `workspaces/<id>/repos.json` — repos managed by that workspace
- `workspaces/<id>/state.json`, `sprints.json` — runtime data, app-managed
- `workspaces/<id>/.backups/` — automatic rotating backups (last 10 per file,
  at most one per 5 minutes)

Jira credentials live outside the repo entirely: `~/.strado/jira.json`
with `{ "baseUrl", "email", "apiToken" }`.
