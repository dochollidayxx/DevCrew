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
4. Builds team: `agentRegistry.buildTeam()` creates **only the Team Lead** — specialist agents are created dynamically later
5. Wires up UI components (tree views, status bar, dashboard) with dynamic agent add/remove listeners
6. Starts the Team Lead and the scheduler polling loop

`stopTeam`, `pauseTeam`, `resumeTeam` manage the lifecycle. All components implement `dispose()`.

### Agent System (`src/agents/`)

**Agent** (abstract base) runs an iterative LLM loop (max 20 iterations per task): build prompt → call LLM → parse XML action tags (`<action type="...">`) → execute action → feed result back → repeat until `complete` action.

Action types: `write_file`, `read_file`, `list_files`, `run_command`, `ask`, `blocker`, `status`, `complete`, `create_agent`, `remove_agent`.

**TeamLeadAgent** handles the full orchestration lifecycle:
1. **Staffing phase:** Analyzes user request and creates specialist agents dynamically via `<agent>` blocks. Can use built-in role templates from `roleDefinitions.ts` or define fully custom roles.
2. **Task decomposition:** Decomposes work into `<task>` blocks with explicit role assignments and dependency chains. Enforces architect-first phasing.
3. **Monitoring:** Polls every 5s, handles blockers, resolves questions from agents.
4. **Integration:** Runs a final pass when all tasks complete (uses local task object, not TaskBoard).
5. **Mid-run management:** Can create/remove agents during execution via `create_agent`/`remove_agent` actions.

**SpecialistAgent** executes individual assigned tasks. Built-in role templates (architect, frontend, backend, tester, reviewer, devops, security, docs) are defined in `src/agents/roles/roleDefinitions.ts`, but any custom role can be created at runtime.

**AgentRegistry** is the dynamic agent manager:
- `buildTeam()` creates only the Team Lead (no args)
- `createAgent(roleConfig)` creates, starts, and registers a specialist at runtime
- `removeAgent(agentId)` stops/disposes a specialist
- Fires `onAgentAdded`/`onAgentRemoved` events for UI refresh
- `AgentRole` is a free-form `string`, not a fixed union type

### Orchestration (`src/orchestration/`)

**TaskBoard** manages task state machine (Pending → Assigned → InProgress → Completed/Failed/Blocked/Paused) with dependency tracking and BFS cycle detection. `completeTask()` accepts an optional completion summary stored in metadata for downstream dependencies.

**Scheduler** polls every 2s, pulls ready tasks (dependencies met), and dispatches them to their explicitly assigned agents. No heuristic matching — tasks have `assigneeId` set by the Team Lead. Enriches tasks with dependency results (completion summaries + file provenance) before dispatch. Capped at `maxParallelAgents` concurrent executions.

### Communication (`src/communication/messageBus.ts`)

Central pub/sub bus with role-based alias routing. Messages route to a specific agent by ID or role alias (`toAgentId`) or broadcast to all (except sender). `registerAlias(role, agentId)` enables addressing agents by role name. 27 MessageTypes covering agent lifecycle, inter-agent Q&A, file ops, and team coordination. Keeps last 1000 messages in history.

### File Operations (`src/fileops/fileManager.ts`)

All file writes go through FileManager which provides per-URI locking (prevents concurrent edits by different agents, auto-releases stale locks after 60s), optional user approval modals, and edit history tracking. Uses VSCode's `WorkspaceEdit` API. Detects create vs replace based on file existence.

## Testing

Tests live in `src/test/*.test.ts`. The `vscode` module is mocked via a path alias in `vitest.config.ts` pointing to `src/test/__mocks__/vscode.ts` — a comprehensive mock of the VSCode API (Uri, EventEmitter, workspace, window, lm, etc.).

Key patterns:
- `vi.useFakeTimers()` for scheduler/polling tests
- Mock LLM responses return XML action tags: `vi.fn().mockResolvedValue('<action type="complete">Done</action>')`
- Each test creates/disposes all services in `beforeEach`/`afterEach`
- Registry tests use `buildTeam()` then `createAgent(ROLE_DEFINITIONS['role'])` for dynamic agent setup
- Coverage excludes `src/test/**` and `src/ui/**`

## Key Conventions

- All inter-component communication uses `vscode.EventEmitter` (reactive/event-driven)
- LLM outputs are structured via XML `<action type="...">...</action>` tags, not JSON
- No external LLM API keys — everything goes through `vscode.lm.selectChatModels()`
- Pause/resume is supported across all layers (scheduler, agents, task board)
- Team composition is dynamic — only the Team Lead exists at startup, specialists are created per-request
- Tasks have explicit `assigneeId` set by Team Lead (no heuristic scheduler matching)
- Dependency results (summary + filesWritten) propagate through the task chain
- The extension manifest in `package.json` defines commands, views, menus, and configuration schema
