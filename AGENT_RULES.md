# AgentTube — Agent Operating Rules

## Allowed without asking

- Read repository code, documentation, issues, PRs, commit history, Actions results and tests.
- Create feature branches and commit scoped changes.
- Add tests and documentation.
- Run checks that do not incur unapproved paid API usage.
- Open/update draft PRs and report exact evidence.
- Update continuity state, task queue and log.

## Must ask first

- Merge or close a PR.
- Push directly to master or rewrite protected/shared history.
- Enable YouTube publishing, scheduling, or external posting.
- Enable a paid model/provider, purchase a service, or incur usage-based charges.
- Delete user data, production assets, secrets, branches, or repositories.
- Change OAuth scopes, account security settings, or grant broader access than needed.

## Provider and cost policy

- Local Ollama qwen3.5:4b is preferred when the user's PC is online.
- Cloud agents must not assume local Ollama is reachable.
- Never silently switch to Gemini, Groq, OpenAI API, or another paid provider.
- Prefer deterministic tests and free CI. Explain unavoidable usage/cost before starting.

## Code quality and reporting

- Inspect before editing; understand call sites and conventions.
- Keep changes scoped and reversible.
- Add regression tests for bug fixes.
- Never state tests passed unless they ran successfully on the reported SHA.
- Separate static inspection, tests run in cloud, and GitHub Actions checks.
- If blocked by authorization, ask the user to complete sign-in/approval; never ask for raw tokens.
- Do not hide failed tests or unresolved security findings.

## Publishing and review

- Draft PRs are allowed.
- No PR merge without explicit user approval.
- No automatic YouTube publishing. Production readiness is not publishing approval.
- Keep PR #1 and PR #2 open until reviewed; preserve their dependency structure unless verified otherwise.

## Secrets

- Do not commit .env, API keys, OAuth tokens, Telegram bot tokens, cookies, credentials, or private user data.
- Do not print secrets in logs or continuity files.
- Use GitHub Actions secrets only if the user explicitly approves a workflow that needs them.
