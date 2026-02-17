import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  TaskStatus,
} from '../types';

function createMockLLM(responseContent = '<action type="complete">Done</action>'): LLMService {
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

describe('TeamLeadAgent - Blocker Handling & Result Storage', () => {
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
    teamLead.start();
  });

  afterEach(() => {
    teamLead.dispose();
    registry.dispose();
    messageBus.dispose();
    fileManager.dispose();
    taskBoard.dispose();
  });

  // ─── BlockerRaised triggers immediate handleBlockedTask ──────────

  describe('BlockerRaised handling', () => {
    it('BlockerRaised message triggers immediate handleBlockedTask', async () => {
      // Create a task on the board and set it as Blocked
      const task = taskBoard.createTask({
        title: 'Build API',
        description: 'Build endpoints',
      });
      taskBoard.assignTask(task.id, 'agent-backend-1');
      taskBoard.startTask(task.id);
      taskBoard.blockTask(task.id);

      // The LLM should be called when handling the blocker
      // Mock it to return a directive
      (mockLLM.sendMessages as ReturnType<typeof vi.fn>).mockResolvedValue(
        '<directive>Try using a different approach</directive>'
      );

      // Simulate a BlockerRaised message arriving at the team lead
      messageBus.publish({
        id: 'msg-blocker-1',
        type: MessageType.BlockerRaised,
        fromAgentId: 'agent-backend-1',
        toAgentId: teamLead.id,
        payload: {
          taskId: task.id,
          description: 'Cannot connect to database',
        },
        timestamp: new Date(),
        replyToMessageId: null,
      });

      // Give the async handler time to run
      await new Promise((r) => setTimeout(r, 50));

      // The LLM should have been called to handle the blocker
      expect(mockLLM.sendMessages).toHaveBeenCalled();

      // Check that the conversation includes the blocked task context
      const lastCall = (mockLLM.sendMessages as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
      const blockerPrompt = lastCall.find(
        (m: any) => m.role === 'user' && m.content.includes('BLOCKED')
      );
      expect(blockerPrompt).toBeDefined();
    });
  });

  // ─── TaskCompleted stores summary in metadata ─────────────────────

  describe('TaskCompleted handling', () => {
    it('TaskCompleted message stores summary in task metadata', () => {
      const task = taskBoard.createTask({
        title: 'Build API',
        description: 'Build endpoints',
      });

      // Simulate a TaskCompleted message arriving at the team lead
      messageBus.publish({
        id: 'msg-complete-1',
        type: MessageType.TaskCompleted,
        fromAgentId: 'agent-backend-1',
        toAgentId: teamLead.id,
        payload: {
          taskId: task.id,
          summary: 'Implemented 5 REST endpoints with validation',
        },
        timestamp: new Date(),
        replyToMessageId: null,
      });

      // The team lead should store the summary on the task
      const updatedTask = taskBoard.getTask(task.id)!;
      expect(updatedTask.metadata['completionSummary']).toBe(
        'Implemented 5 REST endpoints with validation'
      );
    });

    it('TaskCompleted truncates very long summaries', () => {
      const task = taskBoard.createTask({
        title: 'Big Task',
        description: 'Lots of work',
      });

      const longSummary = 'x'.repeat(3000);

      messageBus.publish({
        id: 'msg-complete-2',
        type: MessageType.TaskCompleted,
        fromAgentId: 'agent-backend-1',
        toAgentId: teamLead.id,
        payload: {
          taskId: task.id,
          summary: longSummary,
        },
        timestamp: new Date(),
        replyToMessageId: null,
      });

      const updatedTask = taskBoard.getTask(task.id)!;
      const stored = updatedTask.metadata['completionSummary'] as string;
      expect(stored.length).toBeLessThanOrEqual(2000);
    });
  });

  // ─── Integration phase includes completion summaries ──────────────

  describe('integration phase', () => {
    it('integration includes completion summaries in LLM context', async () => {
      // Create and complete tasks with summaries
      const t1 = taskBoard.createTask({
        title: 'Build API',
        description: 'Build endpoints',
      });
      taskBoard.completeTask(t1.id, 'Built 5 REST endpoints');

      const t2 = taskBoard.createTask({
        title: 'Build UI',
        description: 'Build frontend',
      });
      taskBoard.completeTask(t2.id, 'Created React components for all views');

      // Mock LLM for integration response
      (mockLLM.sendMessages as ReturnType<typeof vi.fn>).mockResolvedValue(
        '<action type="complete">All integrated successfully</action>'
      );

      // Trigger integration by calling the private method
      await (teamLead as any).performIntegration();

      // Check the LLM was called with context that includes summaries
      const integrationCall = (mockLLM.sendMessages as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
      const integrationPrompt = integrationCall.find(
        (m: any) => m.role === 'user' && m.content.includes('Integration Phase')
      );
      expect(integrationPrompt).toBeDefined();
      expect(integrationPrompt.content).toContain('Built 5 REST endpoints');
      expect(integrationPrompt.content).toContain('Created React components');
    });
  });
});

// ─── Multi-Round Lifecycle ────────────────────────────────────────────────

describe('TeamLeadAgent - Multi-Round', () => {
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
    teamLead.start();
  });

  afterEach(() => {
    teamLead.dispose();
    registry.dispose();
    messageBus.dispose();
    fileManager.dispose();
    taskBoard.dispose();
  });

  // ─── prepareForRequest ──────────────────────────────────────────────

  describe('prepareForRequest', () => {
    it('resets integrationCompleted', () => {
      (teamLead as any).integrationCompleted = true;

      (teamLead as any).prepareForRequest();

      expect((teamLead as any).integrationCompleted).toBe(false);
    });

    it('returns fresh mode when board is empty', () => {
      const result = (teamLead as any).prepareForRequest();
      expect(result.mode).toBe('fresh');
      expect(result.boardSummary).toBe('');
    });

    it('returns fresh mode when all tasks are completed', () => {
      const t1 = taskBoard.createTask({ title: 'Done', description: 'Finished' });
      taskBoard.completeTask(t1.id);

      const result = (teamLead as any).prepareForRequest();
      expect(result.mode).toBe('fresh');
    });

    it('clears the board in fresh mode', () => {
      const t1 = taskBoard.createTask({ title: 'Done', description: 'Finished' });
      taskBoard.completeTask(t1.id);

      (teamLead as any).prepareForRequest();

      expect(taskBoard.getStats().total).toBe(0);
    });

    it('returns triage mode when in-progress tasks exist', () => {
      const t1 = taskBoard.createTask({ title: 'Active', description: 'Still running' });
      taskBoard.assignTask(t1.id, 'agent-1');
      taskBoard.startTask(t1.id);

      const result = (teamLead as any).prepareForRequest();
      expect(result.mode).toBe('triage');
      expect(result.boardSummary).toContain('Active');
    });

    it('returns triage mode when pending tasks exist', () => {
      taskBoard.createTask({ title: 'Pending', description: 'Waiting' });

      const result = (teamLead as any).prepareForRequest();
      expect(result.mode).toBe('triage');
    });

    it('does NOT clear the board in triage mode', () => {
      const t1 = taskBoard.createTask({ title: 'Active', description: 'Running' });
      taskBoard.assignTask(t1.id, 'agent-1');
      taskBoard.startTask(t1.id);

      (teamLead as any).prepareForRequest();

      expect(taskBoard.getStats().total).toBe(1);
    });

    it('stops monitoring', () => {
      (teamLead as any).startMonitoring();
      expect((teamLead as any).monitorInterval).not.toBeNull();

      (teamLead as any).prepareForRequest();

      expect((teamLead as any).monitorInterval).toBeNull();
    });

    it('adds NEW ROUND separator in fresh mode', () => {
      const historyBefore = (teamLead as any).conversationHistory.length;

      (teamLead as any).prepareForRequest();

      const history = (teamLead as any).conversationHistory;
      expect(history.length).toBe(historyBefore + 1);
      expect(history[history.length - 1].content).toContain('NEW ROUND');
    });

    it('adds NEW REQUEST separator in triage mode', () => {
      taskBoard.createTask({ title: 'Active', description: 'Running' });

      const historyBefore = (teamLead as any).conversationHistory.length;

      (teamLead as any).prepareForRequest();

      const history = (teamLead as any).conversationHistory;
      expect(history.length).toBe(historyBefore + 1);
      expect(history[history.length - 1].content).toContain('NEW REQUEST');
    });

    it('clears integration queue', () => {
      (teamLead as any).integrationQueue = ['task-1', 'task-2'];

      (teamLead as any).prepareForRequest();

      expect((teamLead as any).integrationQueue).toEqual([]);
    });
  });

  // ─── handleUserRequest dedup and removal ────────────────────────────

  describe('handleUserRequest agent management', () => {
    it('includes request text in decomposition prompt', async () => {
      // LLM returns no agents (keep existing), no tasks
      (mockLLM.sendMessages as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce('')  // staffing
        .mockResolvedValueOnce('');  // decomposition

      await teamLead.handleUserRequest('Add persistent storage');

      // The decomposition prompt (second LLM call) should contain the request text
      const calls = (mockLLM.streamWithProgress as ReturnType<typeof vi.fn>).mock.calls;
      const decompositionCall = calls[1]?.[0]; // second call's messages
      const decompositionPrompt = decompositionCall?.find(
        (m: any) => m.role === 'user' && m.content.includes('Task Decomposition')
      );
      expect(decompositionPrompt).toBeDefined();
      expect(decompositionPrompt.content).toContain('Add persistent storage');
    });

    it('skips creating agent when role already exists (dedup)', async () => {
      // Pre-create a frontend agent
      registry.createAgent(ROLE_DEFINITIONS['frontend']);

      // LLM returns an <agent> block for the same role
      (mockLLM.sendMessages as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce('<agent><role>frontend</role></agent>')  // staffing
        .mockResolvedValueOnce('');  // decomposition

      await teamLead.handleUserRequest('Build a web app');

      // Should still have exactly 1 frontend agent (not 2)
      const frontendAgents = registry.getSpecialists().filter(
        (a) => a.roleConfig.role === 'frontend'
      );
      expect(frontendAgents).toHaveLength(1);
    });

    it('removes agents via <remove_agent> blocks', async () => {
      // Pre-create agents
      registry.createAgent(ROLE_DEFINITIONS['frontend']);
      registry.createAgent(ROLE_DEFINITIONS['backend']);
      expect(registry.getSpecialists()).toHaveLength(2);

      // LLM says remove frontend, add tester
      (mockLLM.sendMessages as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(
          '<remove_agent>frontend</remove_agent>\n<agent><role>tester</role></agent>'
        )  // staffing
        .mockResolvedValueOnce('');  // decomposition

      await teamLead.handleUserRequest('Now test the app');

      // frontend should be gone, backend kept, tester added
      expect(registry.getAgentByRole('frontend')).toBeUndefined();
      expect(registry.getAgentByRole('backend')).toBeDefined();
      expect(registry.getAgentByRole('tester')).toBeDefined();
    });
  });

  // ─── monitorTick after reset ────────────────────────────────────────

  describe('monitorTick after prepareForRequest', () => {
    it('does not bail early after prepareForRequest resets state', async () => {
      // Simulate: round 1 completed integration
      (teamLead as any).integrationCompleted = true;

      // Now reset for round 2
      (teamLead as any).prepareForRequest();

      // Create new tasks for round 2
      const t1 = taskBoard.createTask({ title: 'New task', description: 'Round 2 work' });
      taskBoard.assignTask(t1.id, 'agent-1');
      taskBoard.startTask(t1.id);

      // monitorTick should NOT stop immediately — there's an in-progress task
      (mockLLM.sendMessages as ReturnType<typeof vi.fn>).mockResolvedValue(
        '<action type="complete">Done</action>'
      );

      await (teamLead as any).monitorTick();

      // Monitoring should still be possible (not stopped due to "already done")
      // The key assertion: integrationCompleted is still false (wasn't set back to true)
      expect((teamLead as any).integrationCompleted).toBe(false);
    });

    it('triggers integration when non-cancelled tasks all complete', async () => {
      const t1 = taskBoard.createTask({ title: 'Done task', description: 'Finished' });
      const t2 = taskBoard.createTask({ title: 'Cancelled task', description: 'Dropped' });

      taskBoard.completeTask(t1.id, 'Done');
      taskBoard.cancelTask(t2.id);

      (mockLLM.sendMessages as ReturnType<typeof vi.fn>).mockResolvedValue(
        '<action type="complete">Integrated</action>'
      );

      await (teamLead as any).monitorTick();

      // Integration should have been triggered (integrationCompleted set)
      expect((teamLead as any).integrationCompleted).toBe(true);
    });

    it('excludes cancelled tasks from total', async () => {
      const t1 = taskBoard.createTask({ title: 'Active', description: 'Running' });
      const t2 = taskBoard.createTask({ title: 'Cancelled', description: 'Dropped' });

      taskBoard.assignTask(t1.id, 'agent-1');
      taskBoard.startTask(t1.id);
      taskBoard.cancelTask(t2.id);

      await (teamLead as any).monitorTick();

      // Should not trigger integration or final status — 1 task still in progress
      expect((teamLead as any).integrationCompleted).toBe(false);
    });
  });

  // ─── executeCancellations ──────────────────────────────────────────

  describe('executeCancellations', () => {
    it('cancels tasks and aborts working agents', () => {
      const agent = registry.createAgent(ROLE_DEFINITIONS['backend']);
      const task = taskBoard.createTask({
        title: 'Backend work',
        description: 'Build API',
        assigneeId: agent.id,
      });
      taskBoard.assignTask(task.id, agent.id);
      taskBoard.startTask(task.id);

      // Simulate agent working on this task
      (agent as any).state.status = AgentStatus.Working;
      (agent as any).state.currentTaskId = task.id;

      const response = `<cancel_task>${task.title}</cancel_task>`;
      (teamLead as any).executeCancellations(response);

      expect(taskBoard.getTask(task.id)!.status).toBe(TaskStatus.Cancelled);
      expect(agent.getState().status).toBe(AgentStatus.Idle);
      expect(agent.getState().currentTaskId).toBeNull();
    });

    it('skips already-completed tasks gracefully', () => {
      const task = taskBoard.createTask({ title: 'Done task', description: 'Finished' });
      taskBoard.completeTask(task.id);

      const response = `<cancel_task>${task.title}</cancel_task>`;
      (teamLead as any).executeCancellations(response);

      // Should remain completed
      expect(taskBoard.getTask(task.id)!.status).toBe(TaskStatus.Completed);
    });

    it('cancels tasks by ID', () => {
      const task = taskBoard.createTask({ title: 'By ID', description: 'Cancel by ID' });

      const response = `<cancel_task>${task.id}</cancel_task>`;
      (teamLead as any).executeCancellations(response);

      expect(taskBoard.getTask(task.id)!.status).toBe(TaskStatus.Cancelled);
    });
  });

  // ─── createTasksFromPlan with existing board tasks ─────────────────

  describe('createTasksFromPlan with existing board', () => {
    it('seeds titleToId with existing board tasks', () => {
      // Pre-create a task on the board
      const existing = taskBoard.createTask({
        title: 'Setup infrastructure',
        description: 'From previous request',
        assigneeId: 'agent-1',
      });

      // New tasks reference the existing one by title
      const parsedTasks = [
        {
          title: 'Build API',
          description: 'Build on existing infra',
          role: 'backend',
          priority: 'medium',
          dependsOn: ['Setup infrastructure'],
        },
      ];

      const created = (teamLead as any).createTasksFromPlan(parsedTasks);

      expect(created).toHaveLength(1);
      expect(created[0].dependsOn).toContain(existing.id);
    });
  });

  // ─── buildExistingTeamContext ────────────────────────────────────────

  describe('buildExistingTeamContext', () => {
    it('returns "no specialists" message when team is empty', () => {
      const context = (teamLead as any).buildExistingTeamContext();
      expect(context).toContain('No specialist agents');
    });

    it('lists existing specialists with their roles and status', () => {
      registry.createAgent(ROLE_DEFINITIONS['frontend']);
      registry.createAgent(ROLE_DEFINITIONS['backend']);

      const context = (teamLead as any).buildExistingTeamContext();
      expect(context).toContain('frontend');
      expect(context).toContain('backend');
      expect(context).toContain('Existing Team');
    });
  });

  // ─── parseRemoveAgentBlocks ─────────────────────────────────────────

  describe('parseRemoveAgentBlocks', () => {
    it('parses remove_agent tags from response', () => {
      const response = '<remove_agent>frontend</remove_agent>\n<remove_agent>tester</remove_agent>';
      const roles = (teamLead as any).parseRemoveAgentBlocks(response);
      expect(roles).toEqual(['frontend', 'tester']);
    });

    it('returns empty array when no remove_agent tags', () => {
      const roles = (teamLead as any).parseRemoveAgentBlocks('<agent><role>backend</role></agent>');
      expect(roles).toEqual([]);
    });
  });
});
