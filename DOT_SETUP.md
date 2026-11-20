# ChatGPT Dot — GitHub Handoff Setup

Dot availability depends on account plan, region and gradual rollout. Current OpenAI Help Center eligibility lists Pro, Business Premium, Enterprise, Edu and Healthcare offerings; Free is not listed. Do not upgrade solely for this project before checking whether the feature is actually available at https://chatgpt.com/dots.

## 1. Check Dot access

1. Open https://chatgpt.com/dots in ChatGPT.
2. If Create a dot is available, create one and name it AgentTube.
3. If unavailable, do not upgrade or purchase anything based on an assumption. Continue using these GitHub continuity files with a normal ChatGPT conversation until the user decides otherwise.

## 2. Connect GitHub

1. In ChatGPT, open Settings / Apps (or the app directory) and find GitHub.
2. Connect the GitHub account that can access cansnow32-creator/youtube-automation-agent.
3. Grant only the repository access and actions needed for reading code, creating branches/commits, opening draft PRs and viewing checks.
4. Complete sign-in, repository selection and permission prompts yourself. Never paste a personal access token into a Dot conversation or repository file.

## 3. Standing instructions for Dot

Copy this into the Dot's main conversation:

> You are the continuity agent for cansnow32-creator/youtube-automation-agent (AgentTube). Before work, read AGENT_CONTINUITY.md, AGENT_STATE.md, AGENT_TASKS.md, AGENT_RULES.md and AGENT_LOG.md. Refresh live GitHub PR, branch and check-run state. When I say "Devam et", resume the highest-priority unblocked task from AGENT_TASKS.md. Work only on scoped feature branches, add regression tests, run checks in your cloud environment where possible, and report exact commit SHA and test evidence. Update continuity files after each meaningful work session. You may create commits and draft PRs, but NEVER merge PRs, push to master, enable automatic YouTube publishing, enable paid providers, or incur paid API costs without my explicit approval. Do not assume my PC, local Ollama, local files, local FFmpeg or Windows processes are available. If blocked by authorization or a decision requiring me, stop and ask.

## 4. Cloud-only execution

Prefer Dot's cloud computer or a preconfigured Codex cloud environment for repository work. Do not connect the user's local computer just to make continuity work. Local computer access requires the computer online with ChatGPT desktop running; it is optional and separate from cloud work.

## 5. First smoke test

Ask Dot: "Read the AgentTube continuity files and report the current top task, current PR heads and check status. Do not edit or merge anything yet."

Verify its report against GitHub. Only then ask it to continue.
