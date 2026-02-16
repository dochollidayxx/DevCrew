import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SpecialistAgent } from '../agents/specialistAgent';
import { TeamLeadAgent } from '../agents/teamLeadAgent';
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

function createMockLLM(responseContent = '<action type="complete">All done</action>'): LLMService {
  return {
    modelName: 'test-model',
    sendMessages: vi.fn().mockResolvedValue(responseContent),
    streamMessages: vi.fn(),
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
    });

    it('publishes TaskFailed message on LLM error', async () => {
      (mockLLM.sendMessages as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('API rate limit')
      );

      const handler = vi.fn();
      messageBus.subscribeToType(MessageType.TaskFailed, handler);

      agent.start();
      await agent.executeTask(makeTask());

      expect(handler).toHaveBeenCalled();
      const state = agent.getState();
      expect(state.status).toBe(AgentStatus.Error);
    });

    it('limits iterations to maxIterations', async () => {
      // Return actions that never complete
      (mockLLM.sendMessages as ReturnType<typeof vi.fn>).mockResolvedValue(
        '<action type="status">Still working...</action>'
      );

      agent.start();
      await agent.executeTask(makeTask());

      // Should have called LLM up to 20 times (maxIterations)
      expect(mockLLM.sendMessages).toHaveBeenCalled();
      const callCount = (mockLLM.sendMessages as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callCount).toBeLessThanOrEqual(21); // 20 iterations + possible extra
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
      (mockLLM.sendMessages as ReturnType<typeof vi.fn>)
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
      (mockLLM.sendMessages as ReturnType<typeof vi.fn>)
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
  let teamLead: TeamLeadAgent;

  beforeEach(() => {
    messageBus = new MessageBus();
    fileManager = new FileManager(false, false);
    taskBoard = new TaskBoard();
    mockLLM = createMockLLM();
    teamLead = new TeamLeadAgent(
      ROLE_DEFINITIONS['team-lead'],
      messageBus,
      fileManager,
      taskBoard,
      mockLLM
    );
  });

  it('decomposes a user request into tasks on the board', async () => {
    const llmResponse = `
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

    (mockLLM.sendMessages as ReturnType<typeof vi.fn>).mockResolvedValue(llmResponse);

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
    const llmResponse = `
<question>What database should we use - PostgreSQL or MongoDB?</question>

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

    (mockLLM.sendMessages as ReturnType<typeof vi.fn>).mockResolvedValue(llmResponse);

    teamLead.start();
    await teamLead.handleUserRequest('Build a data layer');

    expect(window.showInputBox).toHaveBeenCalled();

    // Restore
    (window as any).showInputBox = originalShowInputBox;
  });

  it('handles empty task list gracefully', async () => {
    (mockLLM.sendMessages as ReturnType<typeof vi.fn>).mockResolvedValue(
      'I need more information before I can create tasks.'
    );

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

    (mockLLM.sendMessages as ReturnType<typeof vi.fn>).mockResolvedValue(`
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
