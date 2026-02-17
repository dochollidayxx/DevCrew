import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SpecialistAgent } from '../agents/specialistAgent';
import { TeamLeadAgent } from '../agents/teamLeadAgent';
import { AgentRegistry } from '../agents/registry';
import { ROLE_DEFINITIONS } from '../agents/roles/roleDefinitions';
import { MessageBus } from '../communication/messageBus';
import { FileManager } from '../fileops/fileManager';
import { TaskBoard } from '../orchestration/taskBoard';
import {
  AgentStatus,
  LLMService,
  Message,
  MessageType,
  Task,
  TaskPriority,
  TaskStatus,
} from '../types';

vi.mock('child_process', () => ({
  exec: vi.fn((cmd: string, opts: any, cb: Function) => {
    cb(null, 'mock output', '');
  }),
}));

function createMockLLM(responseContent = '<action type="complete">All done</action>'): LLMService {
  const sendMessages = vi.fn().mockResolvedValue(responseContent);
  return {
    modelName: 'test-model',
    sendMessages,
    streamMessages: vi.fn(),
    streamWithProgress: vi.fn().mockImplementation(async (messages: unknown[], onChunk?: (chunk: string, accumulated: string) => void) => {
      const result = await sendMessages(messages);
      onChunk?.(result, result);
      return result;
    }),
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-test-1',
    title: 'Test Task',
    description: 'A test task',
    status: TaskStatus.InProgress,
    priority: TaskPriority.Medium,
    assigneeId: null,
    dependsOn: [],
    blockedBy: [],
    subtasks: [],
    parentTaskId: null,
    files: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    metadata: {},
    ...overrides,
  };
}

describe('Agent - Action Parsing', () => {
  let messageBus: MessageBus;
  let fileManager: FileManager;
  let mockLLM: LLMService;
  let agent: SpecialistAgent;

  beforeEach(() => {
    messageBus = new MessageBus();
    fileManager = new FileManager(false, false);
    mockLLM = createMockLLM();
    agent = new SpecialistAgent(
      ROLE_DEFINITIONS.backend,
      messageBus,
      fileManager,
      mockLLM
    );
  });

  afterEach(() => {
    agent.dispose();
    messageBus.dispose();
    fileManager.dispose();
  });

  // We need to access parseActions which is protected.
  // Create a subclass or cast to any for testing.
  function parseActions(content: string) {
    return (agent as any).parseActions(content);
  }

  describe('parseActions', () => {
    it('parses write_file action', () => {
      const content = `
I'll create the file now.
<action type="write_file">path="src/index.ts"<content>console.log("hello");</content></action>
      `;
      const actions = parseActions(content);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('write_file');
      expect(actions[0].filePath).toBe('src/index.ts');
      expect(actions[0].content).toBe('console.log("hello");');
    });

    it('parses read_file action', () => {
      const content = `
Let me check the existing code.
<action type="read_file">path="package.json"</action>
      `;
      const actions = parseActions(content);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('read_file');
      expect(actions[0].filePath).toBe('package.json');
    });

    it('parses ask action with target', () => {
      const content = `
<action type="ask">to="agent-frontend-123" What component library are we using?</action>
      `;
      const actions = parseActions(content);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('ask');
      expect(actions[0].targetAgentId).toBe('agent-frontend-123');
      expect(actions[0].question).toContain('What component library');
    });

    it('parses ask action without target (broadcast)', () => {
      const content = `
<action type="ask">Does anyone know the API endpoint format?</action>
      `;
      const actions = parseActions(content);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('ask');
      expect(actions[0].targetAgentId).toBeNull();
    });

    it('parses blocker action', () => {
      const content = `
<action type="blocker">Missing database credentials in environment config</action>
      `;
      const actions = parseActions(content);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('blocker');
      expect(actions[0].description).toContain('Missing database credentials');
    });

    it('parses status action', () => {
      const content = `
<action type="status">Finished implementing the user model, moving to routes</action>
      `;
      const actions = parseActions(content);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('status');
      expect(actions[0].message).toContain('Finished implementing');
    });

    it('parses complete action', () => {
      const content = `
<action type="complete">Implemented REST API with 5 endpoints and full validation</action>
      `;
      const actions = parseActions(content);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('complete');
      expect(actions[0].summary).toContain('REST API');
    });

    it('parses multiple actions in one response', () => {
      const content = `
Let me read the existing code first.
<action type="read_file">path="src/app.ts"</action>
<action type="status">Reading existing codebase</action>
      `;
      const actions = parseActions(content);
      expect(actions).toHaveLength(2);
      expect(actions[0].type).toBe('read_file');
      expect(actions[1].type).toBe('status');
    });

    it('returns empty array when no actions found', () => {
      const content = 'This is just a regular response with no action tags.';
      const actions = parseActions(content);
      expect(actions).toHaveLength(0);
    });

    it('handles malformed write_file gracefully (missing path)', () => {
      const content = `
<action type="write_file"><content>some content</content></action>
      `;
      const actions = parseActions(content);
      // Missing path means it shouldn't be parsed
      expect(actions).toHaveLength(0);
    });

    it('handles multiline file content', () => {
      const content = `
<action type="write_file">path="src/utils.ts"<content>
export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}
</content></action>
      `;
      const actions = parseActions(content);
      expect(actions).toHaveLength(1);
      expect(actions[0].content).toContain('export function add');
      expect(actions[0].content).toContain('export function subtract');
    });

    // ─── edit_file Parsing ────────────────────────────────────────────

    it('parses edit_file with path, search, and content', () => {
      const content = `
<action type="edit_file">path="src/app.ts"
<search>const oldValue = "foo";
const otherOld = "bar";</search>
<content>const newValue = "baz";
const otherNew = "qux";</content>
</action>
      `;
      const actions = parseActions(content);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('edit_file');
      expect(actions[0].filePath).toBe('src/app.ts');
      expect(actions[0].search).toContain('const oldValue = "foo"');
      expect(actions[0].content).toContain('const newValue = "baz"');
    });

    it('rejects edit_file missing search tag', () => {
      const content = `
<action type="edit_file">path="src/app.ts"
<content>replacement</content>
</action>
      `;
      const actions = parseActions(content);
      expect(actions).toHaveLength(0);
    });

    it('rejects edit_file missing path', () => {
      const content = `
<action type="edit_file">
<search>some text</search>
<content>replacement</content>
</action>
      `;
      const actions = parseActions(content);
      expect(actions).toHaveLength(0);
    });

    it('handles multiline search/content blocks in edit_file', () => {
      const content = `
<action type="edit_file">path="src/utils.ts"
<search>function add(a: number, b: number): number {
  return a + b;
}</search>
<content>function add(a: number, b: number): number {
  // Validated addition
  return a + b;
}</content>
</action>
      `;
      const actions = parseActions(content);
      expect(actions).toHaveLength(1);
      expect(actions[0].search).toContain('function add');
      expect(actions[0].content).toContain('// Validated addition');
    });

    it('parses edit_file with empty content (deletion)', () => {
      const content = `
<action type="edit_file">path="src/app.ts"
<search>const unused = "remove me";</search>
<content></content>
</action>
      `;
      const actions = parseActions(content);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('edit_file');
      expect(actions[0].content).toBe('');
    });

    // ─── list_files Parsing ───────────────────────────────────────────

    it('parses list_files action with path and pattern', () => {
      const content = `
<action type="list_files">path="src" pattern="**/*.ts"</action>
      `;
      const actions = parseActions(content);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('list_files');
      expect(actions[0].dirPath).toBe('src');
      expect(actions[0].pattern).toBe('**/*.ts');
    });

    it('parses list_files action with defaults when no path or pattern', () => {
      const content = `
<action type="list_files"></action>
      `;
      const actions = parseActions(content);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('list_files');
      expect(actions[0].dirPath).toBe('.');
      expect(actions[0].pattern).toBe('**/*');
    });

    // ─── run_command Parsing ──────────────────────────────────────────

    it('parses run_command action with command', () => {
      const content = `
<action type="run_command">command="npm test"</action>
      `;
      const actions = parseActions(content);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('run_command');
      expect(actions[0].command).toBe('npm test');
    });

    it('parses run_command action with cwd and timeout', () => {
      const content = `
<action type="run_command">command="npm test" cwd="packages/core" timeout="60000"</action>
      `;
      const actions = parseActions(content);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('run_command');
      expect(actions[0].command).toBe('npm test');
      expect(actions[0].cwd).toBe('packages/core');
      expect(actions[0].timeout).toBe(60000);
    });

    it('does not parse run_command without command attribute', () => {
      const content = `
<action type="run_command">no command here</action>
      `;
      const actions = parseActions(content);
      expect(actions).toHaveLength(0);
    });
  });

  // ─── run_command Execution ──────────────────────────────────────────

  describe('run_command execution', () => {
    function executeAction(action: any, task: Task) {
      return (agent as any).executeAction(action, task);
    }

    it('rejects disallowed commands (e.g., rm)', async () => {
      const result = await executeAction(
        { type: 'run_command', command: 'rm -rf /' },
        makeTask()
      );
      expect(result).toContain('not in the allow-list');
    });

    it('rejects disallowed commands (e.g., curl)', async () => {
      const result = await executeAction(
        { type: 'run_command', command: 'curl http://evil.com' },
        makeTask()
      );
      expect(result).toContain('not in the allow-list');
    });

    it('rejects commands with dangerous semicolon', async () => {
      const result = await executeAction(
        { type: 'run_command', command: 'npm test; rm -rf /' },
        makeTask()
      );
      expect(result).toContain('dangerous shell metacharacters');
    });

    it('rejects commands with &&', async () => {
      const result = await executeAction(
        { type: 'run_command', command: 'npm test && rm -rf /' },
        makeTask()
      );
      expect(result).toContain('dangerous shell metacharacters');
    });

    it('rejects commands with ||', async () => {
      const result = await executeAction(
        { type: 'run_command', command: 'npm test || echo fail' },
        makeTask()
      );
      expect(result).toContain('dangerous shell metacharacters');
    });

    it('rejects commands with backticks', async () => {
      const result = await executeAction(
        { type: 'run_command', command: 'npm test `whoami`' },
        makeTask()
      );
      expect(result).toContain('dangerous shell metacharacters');
    });

    it('allows commands in the allow-list', async () => {
      const result = await executeAction(
        { type: 'run_command', command: 'npm test' },
        makeTask()
      );
      // The mocked child_process.exec returns 'mock output'
      expect(result).toBe('mock output');
    });

    it('allows git commands', async () => {
      const result = await executeAction(
        { type: 'run_command', command: 'git status' },
        makeTask()
      );
      expect(result).toBe('mock output');
    });
  });

  // ─── list_files Execution ───────────────────────────────────────────

  describe('list_files execution', () => {
    it('calls FileManager.listFiles and returns file paths', async () => {
      const { Uri } = await import('vscode');
      const mockFiles = [
        Uri.file('/workspace/src/index.ts'),
        Uri.file('/workspace/src/app.ts'),
      ];
      vi.spyOn(fileManager, 'listFiles').mockResolvedValue(mockFiles);

      const result = await (agent as any).executeAction(
        { type: 'list_files', dirPath: 'src', pattern: '**/*.ts' },
        makeTask()
      );

      expect(fileManager.listFiles).toHaveBeenCalled();
      expect(result).toContain('src/index.ts');
      expect(result).toContain('src/app.ts');
    });

    it('returns "No files found." when empty', async () => {
      vi.spyOn(fileManager, 'listFiles').mockResolvedValue([]);

      const result = await (agent as any).executeAction(
        { type: 'list_files', dirPath: '.', pattern: '**/*.xyz' },
        makeTask()
      );

      expect(result).toContain('No files found matching pattern');
    });
  });

  // ─── edit_file Execution ────────────────────────────────────────────

  describe('edit_file execution', () => {
    function executeAction(action: any, task: Task) {
      return (agent as any).executeAction(action, task);
    }

    it('successfully edits a file with unique match', async () => {
      const fileContent = 'line one\nconst x = 1;\nline three\n';
      vi.spyOn(fileManager, 'readFile').mockResolvedValue(fileContent);
      vi.spyOn(fileManager, 'applyEdit').mockResolvedValue(true);

      const result = await executeAction(
        {
          type: 'edit_file',
          filePath: 'src/app.ts',
          search: 'const x = 1;',
          content: 'const x = 2;',
        },
        makeTask()
      );

      expect(result).toBe('File edited: src/app.ts');
      expect(fileManager.applyEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'replace',
          content: 'const x = 2;',
          range: expect.objectContaining({
            start: expect.objectContaining({ line: 1, character: 0 }),
            end: expect.objectContaining({ line: 1, character: 12 }),
          }),
        })
      );
    });

    it('returns error when search text is not found', async () => {
      vi.spyOn(fileManager, 'readFile').mockResolvedValue('some other content');
      vi.spyOn(fileManager, 'applyEdit').mockResolvedValue(true);

      const result = await executeAction(
        {
          type: 'edit_file',
          filePath: 'src/app.ts',
          search: 'nonexistent text',
          content: 'replacement',
        },
        makeTask()
      );

      expect(result).toContain('Error');
      expect(result).toContain('not found');
      expect(fileManager.applyEdit).not.toHaveBeenCalled();
    });

    it('returns error when multiple matches exist', async () => {
      const fileContent = 'const x = 1;\nconst y = 2;\nconst x = 1;\n';
      vi.spyOn(fileManager, 'readFile').mockResolvedValue(fileContent);
      vi.spyOn(fileManager, 'applyEdit').mockResolvedValue(true);

      const result = await executeAction(
        {
          type: 'edit_file',
          filePath: 'src/app.ts',
          search: 'const x = 1;',
          content: 'const x = 3;',
        },
        makeTask()
      );

      expect(result).toContain('Error');
      expect(result).toContain('multiple locations');
      expect(fileManager.applyEdit).not.toHaveBeenCalled();
    });

    it('returns error when file does not exist', async () => {
      vi.spyOn(fileManager, 'readFile').mockRejectedValue(new Error('Cannot read file'));

      const result = await executeAction(
        {
          type: 'edit_file',
          filePath: 'src/missing.ts',
          search: 'anything',
          content: 'replacement',
        },
        makeTask()
      );

      expect(result).toContain('Error');
      expect(result).toContain('File not found');
    });

    it('publishes FileEdited message on success', async () => {
      const fileContent = 'const x = 1;';
      vi.spyOn(fileManager, 'readFile').mockResolvedValue(fileContent);
      vi.spyOn(fileManager, 'applyEdit').mockResolvedValue(true);

      (mockLLM.streamWithProgress as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(
          '<action type="edit_file">path="src/app.ts"<search>const x = 1;</search><content>const x = 2;</content></action>'
        )
        .mockResolvedValueOnce(
          '<action type="complete">Done</action>'
        );

      const handler = vi.fn();
      messageBus.subscribeToType(MessageType.FileEdited, handler);

      agent.start();
      await agent.executeTask(makeTask());

      expect(handler).toHaveBeenCalled();
      const msg = handler.mock.calls[0][0] as Message;
      expect((msg.payload as any).filePath).toBe('src/app.ts');
    });
  });

  // ─── Task Execution ────────────────────────────────────────────────

  describe('executeTask', () => {
    it('runs to completion with a simple complete action', async () => {
      agent.start();
      const task = makeTask();
      await agent.executeTask(task);

      const state = agent.getState();
      expect(state.status).toBe(AgentStatus.Idle);
      expect(state.completedTaskIds).toContain(task.id);
      expect(state.currentTaskId).toBeNull();
    });

    it('publishes TaskCompleted message on success', async () => {
      const handler = vi.fn();
      messageBus.subscribeToType(MessageType.TaskCompleted, handler);

      agent.start();
      await agent.executeTask(makeTask());

      expect(handler).toHaveBeenCalled();
      const msg = handler.mock.calls[0][0] as Message;
      expect((msg.payload as any).taskId).toBe('task-test-1');
      expect((msg.payload as any).taskTitle).toBe('Test Task');
    });

    it('publishes TaskFailed message on LLM error', async () => {
      (mockLLM.streamWithProgress as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('API rate limit')
      );

      const handler = vi.fn();
      messageBus.subscribeToType(MessageType.TaskFailed, handler);

      agent.start();
      await expect(agent.executeTask(makeTask())).rejects.toThrow('API rate limit');

      expect(handler).toHaveBeenCalled();
      const msg = handler.mock.calls[0][0] as Message;
      expect((msg.payload as any).taskId).toBe('task-test-1');
      expect((msg.payload as any).taskTitle).toBe('Test Task');
      const state = agent.getState();
      expect(state.status).toBe(AgentStatus.Error);
    });

    it('limits iterations to maxIterations', async () => {
      // Return actions that never complete
      (mockLLM.streamWithProgress as ReturnType<typeof vi.fn>).mockResolvedValue(
        '<action type="status">Still working...</action>'
      );

      agent.start();
      const customLimit = 10;
      const summary = await agent.executeTask(makeTask(), customLimit);

      // Should have called LLM exactly customLimit times
      const callCount = (mockLLM.streamWithProgress as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callCount).toBe(customLimit);

      // Summary should indicate incomplete
      expect(summary).toContain('INCOMPLETE');
      expect(summary).toContain(`${customLimit} iteration limit`);
    });

    it('recovers from inactivity timeout and continues', async () => {
      vi.useFakeTimers();

      let callCount = 0;
      (mockLLM.streamWithProgress as ReturnType<typeof vi.fn>).mockImplementation(
        () => {
          callCount++;
          if (callCount === 1) {
            // First call: never resolves (simulates hang with no data flowing)
            return new Promise<string>(() => {});
          }
          // Second call: completes normally
          return Promise.resolve('<action type="complete">Done after timeout recovery</action>');
        }
      );

      agent.start();
      const taskPromise = agent.executeTask(makeTask());

      // Advance past the 30-second inactivity timeout
      await vi.advanceTimersByTimeAsync(31_000);

      const summary = await taskPromise;
      expect(summary).toContain('Done after timeout recovery');
      expect(callCount).toBe(2);

      vi.useRealTimers();
    });

    it('returns a completion summary string', async () => {
      (mockLLM.streamWithProgress as ReturnType<typeof vi.fn>).mockResolvedValue(
        '<action type="complete">Built the auth module with JWT</action>'
      );

      agent.start();
      const summary = await agent.executeTask(makeTask());

      expect(typeof summary).toBe('string');
      expect(summary).toContain('Built the auth module with JWT');
    });
  });

  // ─── Blocking Questions ─────────────────────────────────────────────

  describe('blocking questions (handleAsk)', () => {
    it('handleAsk returns a promise that resolves when answer arrives', async () => {
      agent.start();

      // Capture the question message when published
      let capturedQuestionId: string | undefined;
      messageBus.subscribeToType(MessageType.Question, (msg) => {
        capturedQuestionId = (msg.payload as any).questionId;
      });

      const askPromise = (agent as any).handleAsk({
        type: 'ask',
        targetAgentId: null,
        question: 'What database?',
      });

      // Simulate an answer arriving
      await vi.dynamicImportSettled();
      expect(capturedQuestionId).toBeDefined();

      (agent as any).resolveAnswer(capturedQuestionId!, 'PostgreSQL');

      const result = await askPromise;
      expect(result).toContain('PostgreSQL');
    });

    it('handleAsk resolves with timeout message after 30s if no answer', async () => {
      vi.useFakeTimers();

      agent.start();

      const askPromise = (agent as any).handleAsk({
        type: 'ask',
        targetAgentId: null,
        question: 'What database?',
      });

      // Advance past 30 seconds
      vi.advanceTimersByTime(31_000);

      const result = await askPromise;
      expect(result).toContain('No response received (timeout)');

      vi.useRealTimers();
    });
  });

  // ─── cancelCurrentTask ─────────────────────────────────────────────

  describe('cancelCurrentTask', () => {
    it('sets status to Idle', () => {
      agent.start();
      // Simulate working state
      (agent as any).state.status = AgentStatus.Working;
      (agent as any).state.currentTaskId = 'task-123';

      agent.cancelCurrentTask();

      expect(agent.getState().status).toBe(AgentStatus.Idle);
    });

    it('clears currentTaskId', () => {
      agent.start();
      (agent as any).state.currentTaskId = 'task-123';

      agent.cancelCurrentTask();

      expect(agent.getState().currentTaskId).toBeNull();
    });

    it('keeps message subscription alive (unlike stop)', () => {
      agent.start();
      (agent as any).state.status = AgentStatus.Working;
      (agent as any).state.currentTaskId = 'task-123';

      agent.cancelCurrentTask();

      // The messageSubscription should still be active (not disposed)
      expect((agent as any).messageSubscription).toBeDefined();
    });
  });

  // ─── State Management ──────────────────────────────────────────────

  describe('state', () => {
    it('initial state is Idle', () => {
      expect(agent.getState().status).toBe(AgentStatus.Idle);
    });

    it('has correct role info', () => {
      const state = agent.getState();
      expect(state.role).toBe('backend');
      expect(state.name).toBe('Backend Dev');
    });

    it('fires onStateChange when status changes', async () => {
      const listener = vi.fn();
      agent.onStateChange(listener);

      agent.start();
      await agent.executeTask(makeTask());

      // Should have fired at least twice (Working, then Idle on completion)
      expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── Messaging ─────────────────────────────────────────────────────

  describe('messaging', () => {
    it('sends StatusUpdate messages for status actions', async () => {
      (mockLLM.streamWithProgress as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(
          '<action type="status">Working on it</action>'
        )
        .mockResolvedValueOnce(
          '<action type="complete">Done</action>'
        );

      const handler = vi.fn();
      messageBus.subscribeToType(MessageType.StatusUpdate, handler);

      agent.start();
      await agent.executeTask(makeTask());

      expect(handler).toHaveBeenCalled();
    });

    it('sends BlockerRaised messages for blocker actions', async () => {
      (mockLLM.streamWithProgress as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(
          '<action type="blocker">Need database access</action>'
        )
        .mockResolvedValueOnce(
          '<action type="complete">Done after unblock</action>'
        );

      const handler = vi.fn();
      messageBus.subscribeToType(MessageType.BlockerRaised, handler);

      agent.start();
      await agent.executeTask(makeTask());

      expect(handler).toHaveBeenCalled();
    });
  });
});

// ─── TeamLeadAgent Task Decomposition ────────────────────────────────────────

describe('TeamLeadAgent - Task Decomposition Parsing', () => {
  let messageBus: MessageBus;
  let fileManager: FileManager;
  let taskBoard: TaskBoard;
  let mockLLM: LLMService;
  let registry: AgentRegistry;
  let teamLead: TeamLeadAgent;

  beforeEach(() => {
    messageBus = new MessageBus();
    fileManager = new FileManager(false, false);
    taskBoard = new TaskBoard();
    mockLLM = createMockLLM();
    registry = new AgentRegistry(messageBus, fileManager, taskBoard, mockLLM);
    teamLead = new TeamLeadAgent(
      ROLE_DEFINITIONS['team-lead'],
      messageBus,
      fileManager,
      taskBoard,
      mockLLM,
      registry
    );
  });

  afterEach(() => {
    teamLead.dispose();
    registry.dispose();
    messageBus.dispose();
    fileManager.dispose();
    taskBoard.dispose();
  });

  it('decomposes a user request into tasks on the board', async () => {
    // handleUserRequest now makes two streaming LLM calls:
    // 1. Staffing (agent blocks) — return empty for this test
    // 2. Task decomposition (task blocks)
    const staffingResponse = `No agents needed for this test.`;
    const decompositionResponse = `
Here's my plan:

<task>
  <title>Design API schema</title>
  <description>Create OpenAPI spec for the REST endpoints</description>
  <role>architect</role>
  <priority>high</priority>
</task>

<task>
  <title>Implement API endpoints</title>
  <description>Build Express routes based on the schema</description>
  <role>backend</role>
  <priority>medium</priority>
  <depends_on>Design API schema</depends_on>
</task>

<task>
  <title>Write API tests</title>
  <description>Create integration tests for all endpoints</description>
  <role>tester</role>
  <priority>medium</priority>
  <depends_on>Implement API endpoints</depends_on>
</task>
    `;

    (mockLLM.streamWithProgress as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(staffingResponse)
      .mockResolvedValueOnce(decompositionResponse);

    teamLead.start();
    await teamLead.handleUserRequest('Build a REST API for user management');

    const tasks = taskBoard.getAllTasks();
    expect(tasks).toHaveLength(3);
    expect(tasks.map((t) => t.title)).toEqual([
      'Design API schema',
      'Implement API endpoints',
      'Write API tests',
    ]);

    // Check priorities
    const schemaTask = tasks.find((t) => t.title === 'Design API schema')!;
    expect(schemaTask.priority).toBe(TaskPriority.High);

    // Check dependencies
    const implTask = tasks.find((t) => t.title === 'Implement API endpoints')!;
    expect(implTask.dependsOn).toContain(schemaTask.id);

    const testTask = tasks.find((t) => t.title === 'Write API tests')!;
    expect(testTask.dependsOn).toContain(implTask.id);
  });

  it('handles user questions from the LLM response', async () => {
    // Staffing returns a question; decomposition returns tasks
    const staffingResponse = `
<question>What database should we use - PostgreSQL or MongoDB?</question>
    `;
    const decompositionResponse = `
<task>
  <title>Set up database</title>
  <description>Configure the database</description>
  <role>backend</role>
  <priority>high</priority>
</task>
    `;

    // Mock showInputBox to return an answer
    const { window } = await import('vscode');
    const originalShowInputBox = window.showInputBox;
    (window as any).showInputBox = vi.fn().mockResolvedValue('PostgreSQL');

    (mockLLM.streamWithProgress as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(staffingResponse)
      .mockResolvedValueOnce(decompositionResponse);

    teamLead.start();
    await teamLead.handleUserRequest('Build a data layer');

    expect(window.showInputBox).toHaveBeenCalled();

    // Restore
    (window as any).showInputBox = originalShowInputBox;
  });

  it('handles empty task list gracefully', async () => {
    (mockLLM.streamWithProgress as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('No agents needed.')
      .mockResolvedValueOnce('I need more information before I can create tasks.');

    teamLead.start();
    await teamLead.handleUserRequest('Do something');

    expect(taskBoard.getAllTasks()).toHaveLength(0);
  });

  it('chatWithUser returns LLM response with status context', async () => {
    (mockLLM.sendMessages as ReturnType<typeof vi.fn>).mockResolvedValue(
      'Everything is on track. 2 of 3 tasks are complete.'
    );

    teamLead.start();
    const response = await teamLead.chatWithUser('How is the project going?');

    expect(response).toContain('on track');
    expect(mockLLM.sendMessages).toHaveBeenCalled();

    // Verify it included status context
    const lastCall = (mockLLM.sendMessages as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    const lastUserMsg = lastCall.filter((m: any) => m.role === 'user').at(-1);
    expect(lastUserMsg.content).toContain('Current Status');
  });

  it('publishes TaskDecomposition message after creating tasks', async () => {
    const handler = vi.fn();
    messageBus.subscribeToType(MessageType.TaskDecomposition, handler);

    (mockLLM.streamWithProgress as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('No agents needed.')
      .mockResolvedValueOnce(`
<task>
  <title>Task A</title>
  <description>Do A</description>
  <role>backend</role>
  <priority>medium</priority>
</task>
      `);

    teamLead.start();
    await teamLead.handleUserRequest('Build something');

    expect(handler).toHaveBeenCalled();
    const msg = handler.mock.calls[0][0] as Message;
    expect((msg.payload as any).taskCount).toBe(1);
  });
});
