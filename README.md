# IssuePilot

Local MVP for taking a GitHub repository and issue from analysis through implementation, test/repair, diff, and commit.

## Run

```bash
npm install
npm start
```

Open `http://localhost:3000`.

Sign in to the locally installed OpenAI Codex CLI with your ChatGPT account to enable the implementation step. IssuePilot runs its project-local `@openai/codex` CLI with `codex exec --ephemeral --sandbox workspace-write` inside the isolated clone and does not read, store, or expose API keys. Set `CODEX_CLI_PATH` only to override that bundled local launcher. A configured `GITHUB_TOKEN` enables the optional PR request after a successful commit.

All target repositories are cloned to an isolated operating-system temporary directory, never into this project.
