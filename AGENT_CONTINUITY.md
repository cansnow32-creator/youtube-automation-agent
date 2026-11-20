# Agent Continuity — Start Here

This repository is the durable source of truth for ongoing AgentTube development. A new ChatGPT conversation or the user's dot must read this file and the linked state/task/rules files before changing code.

## Resume command

When the user says **"Devam et"**, **"Devam edelim"**, or **"continue"**:

1. Read AGENT_CONTINUITY.md, AGENT_STATE.md, AGENT_TASKS.md, AGENT_RULES.md, and the latest entries in AGENT_LOG.md.
2. Query GitHub live for the default branch, open PRs, their head/base SHAs, draft/merge state, and checks for each current head. GitHub state wins over stale notes.
3. Inspect the current task's actual files and diff. Do not assume a task was completed merely because it is listed in the log.
4. Select the highest-priority unblocked task. Continue without asking the user to repeat known context.
5. Work on a scoped feature branch. Never push directly to master.
6. Add regression tests for code changes. Report exact SHA and checks actually run.
7. Update AGENT_STATE.md, AGENT_TASKS.md, and append a dated entry to AGENT_LOG.md after each meaningful session.
8. Open or update a draft PR when a coherent change is ready. Never merge without explicit user approval.

## Dot / ChatGPT handoff

The dot should use the connected GitHub app/account to inspect and update this repository. Prefer its cloud computer or a Codex cloud environment for code execution. The user's local PC is not required for cloud-only work. Never assume local files, Ollama, FFmpeg, browser sessions, or Windows processes are accessible from the cloud.

Before the first Dot coding task, confirm it can read this repository and create a branch/PR. Use least-privilege GitHub permissions. Never paste personal access tokens, API keys, bot tokens, or secrets into repository files or chat.

## Scope boundaries

This continuity system tracks AgentTube development; it does not itself run a coding model. GitHub Actions perform deterministic checks only. They do not autonomously author code, call paid model APIs, or publish YouTube content.

The future Video DNA / Animation Reconstruction Studio is a separate feature and must not be mixed into production-recovery work without explicit scope approval.
