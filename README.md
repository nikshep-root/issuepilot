# IssuePilot

> Turn a GitHub issue into a tested, reviewable local Git commit.

IssuePilot is a lightweight hackathon MVP for an assisted engineering workflow. Supply a GitHub repository URL and issue; IssuePilot clones the repository into an isolated temporary workspace, maps the codebase, asks OpenAI Codex to make a focused change, runs tests, attempts repairs when tests fail, and presents the final diff and commit result.

## Workflow

```text
Repository URL + issue
        ↓
Isolated git clone
        ↓
Repository analysis + test detection
        ↓
Implementation plan
        ↓
OpenAI Codex CLI implements the change
        ↓
Run tests → repair with Codex (up to 3 times)
        ↓
Show git diff → create local branch and commit
```

The original repository is never edited directly. Every run works in an operating-system temporary directory and its workspace is later removed.

## Features

- Accepts a GitHub HTTPS repository URL, issue title, and issue description.
- Clones the target repository in an isolated workspace.
- Samples up to 250 files while ignoring `.git`, `node_modules`, `dist`, `build`, and other generated folders.
- Detects common test commands: Node.js (`npm test`), Python (`python -m pytest`), Maven, Gradle, and Go.
- Runs OpenAI Codex locally with `codex exec --ephemeral --sandbox workspace-write`.
- Sends test failures to Codex for up to three repair attempts.
- Displays the resulting Git diff.
- Creates an `issuepilot/...` branch and commit only after tests pass.
- Supports an optional GitHub pull-request request when `GITHUB_TOKEN` is configured.

## Requirements

- Node.js 18+ (the development environment uses Node 25).
- Git available on `PATH`.
- Network access to clone GitHub repositories.
- A locally authenticated OpenAI Codex CLI session for the ChatGPT account running IssuePilot.

IssuePilot does **not** store, request, or expose OpenAI API keys. Codex uses its own saved ChatGPT/Codex authentication.

## Installation

```bash
git clone https://github.com/nikshep-root/issuepilot.git
cd issuepilot
npm install
```

### Authenticate Codex

Run this from a normal user terminal, not a restricted service account.

#### Windows Command Prompt

```cmd
set HOME=%USERPROFILE%
set CODEX_HOME=%USERPROFILE%\.codex
node node_modules\@openai\codex\bin\codex.js login
```

#### PowerShell

```powershell
$env:HOME = $env:USERPROFILE
$env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex'
node .\node_modules\@openai\codex\bin\codex.js login
```

Verify the CLI before starting the app:

```cmd
node node_modules\@openai\codex\bin\codex.js exec --ephemeral --sandbox read-only "Reply exactly READY"
```

Expected output: `READY`.

## Run

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000). For reload-on-save development, run `npm run dev`.

To use another port:

```cmd
set PORT=3001
npm start
```

## Use the application

1. Enter a public GitHub HTTPS repository URL, such as `https://github.com/owner/repository.git`.
2. Enter a concise issue title and clear acceptance criteria.
3. Select **Run IssuePilot**.
4. Follow the status through cloning, analysis, implementation, testing/repair, diff, and commit.
5. Review the displayed diff and branch/commit result.

Run data lives in server memory. Keep the page open until completion: refreshing the page clears the displayed result.

## Demo repository

Use this separately published demo API for a safe presentation:

```text
https://github.com/nikshep-root/issuepilot-demo-target-api.git
```

**Issue title**

```text
Add a lookup endpoint for a widget by ID
```

**Issue description**

```text
Add GET /api/widgets/:id to the demo API.

For an existing widget ID such as "alpha", return HTTP 200 with:
{ "data": { "id": "alpha", "name": "Alpha Widget", "status": "active" } }

For an unknown widget ID, return HTTP 404 with:
{ "error": "Widget not found" }

Keep GET /health and GET /api/widgets unchanged.
Add focused tests for both the successful lookup and the 404 case.
```

Expected behavior after a successful run:

```text
GET /api/widgets/alpha    → 200 with the Alpha Widget
GET /api/widgets/unknown  → 404 with { "error": "Widget not found" }
GET /api/widgets          → unchanged
GET /health               → unchanged
```

## Architecture

IssuePilot deliberately uses one Node.js process: no database, auth UI, background queue, or microservices.

| Component | Responsibility |
| --- | --- |
| `public/` | Browser interface for submitting and polling a run. |
| `server.mjs` | HTTP API, orchestration, analysis, tests, diff, and Git actions. |
| `@openai/codex` | Project-local OpenAI Codex CLI launcher. |
| OS temporary directory | Per-run isolated repository clone. |
| GitHub REST API | Optional pull-request request. |

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | No | Web server port; defaults to `3000`. |
| `HOME` | Recommended on Windows | Lets Codex find the signed-in user profile. |
| `CODEX_HOME` | Recommended on Windows | Codex configuration/session directory, normally `%USERPROFILE%\.codex`. |
| `GITHUB_TOKEN` | No | Enables the optional PR API request. Never commit it. |

## Security

- Target repositories are cloned outside the IssuePilot project directory.
- Codex has write access only to the isolated clone through `workspace-write` sandboxing.
- Codex runs with `--ephemeral`, avoiding persistent run rollout files.
- `.env` files, runtime artifacts, `node_modules`, and the local demo folder are ignored by Git.
- No OpenAI API key is hardcoded or read by IssuePilot.
- `GITHUB_TOKEN` is used only server-side for the optional PR request.

## MVP limitations

- Target repositories must be reachable via GitHub HTTPS. Private repositories need Git credentials already available to Git on the host.
- This MVP detects test commands but does not run a separate dependency-install phase for the cloned project.
- Results are in memory and are lost after a server restart or page refresh.
- Branches and commits are local to the isolated clone. The optional PR request requires the matching remote branch, so branch pushing is the next production-hardening step.
- Codex authentication is a local prerequisite. If unavailable, IssuePilot displays the CLI error instead of storing credentials or silently continuing.

## Troubleshooting

### Port 3000 is already in use

Stop the existing server or select another port:

```cmd
set PORT=3001
npm start
```

### `Reading additional input from stdin...`

Pull the latest `main` branch. IssuePilot closes Codex stdin, so `codex exec` uses its prompt instead of waiting for piped input.

### Codex cannot find its home directory or session

Run the app from your normal user terminal and set `HOME` and `CODEX_HOME` as shown above. Complete `codex login` first.

### Tests fail after repairs

IssuePilot shows the test output and final diff, then intentionally skips the commit so a failing change cannot be presented as complete.

## Development verification

The demo API uses Node's built-in test runner:

```bash
npm --prefix demo-target-api test
```

## License

Hackathon MVP, provided for demonstration and evaluation.
