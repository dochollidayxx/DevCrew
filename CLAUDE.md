# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run compile        # Dev build (webpack)
npm run watch          # Dev build with file watching
npm run package        # Production build (hidden source maps)
npm run lint           # ESLint on src/**/*.ts
npm test               # Run all tests (vitest, single run)
npm run test:watch     # Tests in watch mode
npm run test:coverage  # Tests with v8 coverage (text + lcov)
```

Run a single test file:
```bash
npx vitest run src/test/scheduler.test.ts
```

Run tests matching a name pattern:
```bash
npx vitest run -t "should dispatch"
```

CI runs the test matrix on Node 18/20/22, then verifies `tsc --noEmit` and webpack build produce `dist/extension.js`.

## Architecture

DevCrew is a VSCode extension that orchestrates a parallel team of LLM-powered agents to collaboratively work on coding tasks.

### Activation & Lifecycle

`extension.ts` registers 7 commands. The `startTeam` command bootstraps the entire system:

1. Reads config (`src/config/settings.ts`) from VSCode workspace settings (`devcrew.*`)
2. Initializes the LLM service (`src/config/llmProviders.ts`) via VSCode's Language Model API (`vscode.lm`) — no API keys; requires an installed LM provider (e.g. GitHub Copilot Chat)
3. Creates core services: MessageBus → FileManager → TaskBoard → AgentRegistry → Scheduler
4. Wires up UI components (tree views, status bar, dashboard)
5. Starts all agents and the scheduler polling loop

`stopTeam`, `pauseTeam`, `resumeTeam` manage the lifecycle. All components implement `dispose()`.

### Agent System (`src/agents/`)

**Agent** (abstract base) runs an iterative LLM loop (max 20 iterations per task): build prompt → call LLM → parse XML action tags (`<action type="...">`) → execute action → feed result back → repeat until `complete` action.

Action types: `write_file`, `read_file`, `ask`, `blocker`, `status`, `complete`.

**TeamLeadAgent** decomposes user requests into a dependency graph of tasks (via LLM), creates them on the TaskBoard, then monitors progress every 5s. Handles blocked tasks and runs a final integration phase when all tasks complete.

**SpecialistAgent** executes individual assigned tasks. Roles (architect, frontend, backend, tester, reviewer, devops, security, docs) are defined in `src/agents/roles/roleDefinitions.ts` with per-role system prompts and capabilities.

**AgentRegistry** is the factory — always creates one TeamLead plus specialists per configured role.

### Orchestration (`src/orchestration/`)

**TaskBoard** manages task state machine (Pending → Assigned → InProgress → Completed/Failed/Blocked/Paused) with dependency tracking and BFS cycle detection.

**Scheduler** polls every 2s, pulls ready tasks (dependencies met), sorts by priority, matches to idle agents by capability keyword overlap + load balancing, then dispatches. Capped at `maxParallelAgents` concurrent executions.

### Communication (`src/communication/messageBus.ts`)

Central pub/sub bus. Messages route to a specific agent (`toAgentId`) or broadcast to all (except sender). 27 MessageTypes covering agent lifecycle, inter-agent Q&A, file ops, and team coordination. Keeps last 1000 messages in history.

### File Operations (`src/fileops/fileManager.ts`)

All file writes go through FileManager which provides per-URI locking (prevents concurrent edits by different agents), optional user approval modals, and edit history tracking. Uses VSCode's `WorkspaceEdit` API.

## Testing

Tests live in `src/test/*.test.ts`. The `vscode` module is mocked via a path alias in `vitest.config.ts` pointing to `src/test/__mocks__/vscode.ts` — a comprehensive 350-line mock of the VSCode API (Uri, EventEmitter, workspace, window, lm, etc.).

Key patterns:
- `vi.useFakeTimers()` for scheduler/polling tests
- Mock LLM responses return XML action tags: `vi.fn().mockResolvedValue('<action type="complete">Done</action>')`
- Each test creates/disposes all services in `beforeEach`/`afterEach`
- Coverage excludes `src/test/**` and `src/ui/**`

## Key Conventions

- All inter-component communication uses `vscode.EventEmitter` (reactive/event-driven)
- LLM outputs are structured via XML `<action type="...">...</action>` tags, not JSON
- No external LLM API keys — everything goes through `vscode.lm.selectChatModels()`
- Pause/resume is supported across all layers (scheduler, agents, task board)
- The extension manifest in `package.json` defines commands, views, menus, and configuration schema
