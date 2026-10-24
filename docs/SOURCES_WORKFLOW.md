# Official implementation-workflow references
Checked 24 October 2026. Recheck installed versions during P00; avoid inventing CLI flags or assuming features are present.

- Codex/shared project instructions: https://learn.chatgpt.com/docs/agent-configuration/agents-md
- Codex subagents: https://learn.chatgpt.com/docs/agent-configuration/subagents
- Git worktrees in Codex/ChatGPT environments: https://learn.chatgpt.com/docs/environments/git-worktrees
- Claude Code project memory/imports: https://code.claude.com/docs/en/memory
- Claude Code subagents/worktree isolation: https://code.claude.com/docs/en/sub-agents
- Claude Code agent teams: https://code.claude.com/docs/en/agent-teams
- Tauri native WebDriver testing: https://v2.tauri.app/develop/tests/webdriver/
- WebdriverIO Tauri Windows platform support: https://webdriver.io/docs/desktop-testing/tauri/platform-support
- Microsoft WebView2 automation: https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/webdriver

Practical choices in this pack:
AGENTS.md is the canonical cross-tool instruction file. CLAUDE.md explicitly imports it for compatibility. Optional Claude subagent wrappers do not select a model or change permission modes. Explicit worktree baseline checks are required, even if the tool can create worktrees automatically. Agent-team features are optional; their availability/resumption behavior is not a dependency of the task graph.

Tauri/WebdriverIO supports native-app testing, including routes with test instrumentation. Native test configuration must use real commands/storage for the behavior under test, and instrumentation must be removed or unavailable in release. Windows UI tests still need suitable native runtime/desktop capabilities; physical audio and actual meeting capture are separate checks.

Product implementation sources remain in docs/ARCHITECTURE.md.

