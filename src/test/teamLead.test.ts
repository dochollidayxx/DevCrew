import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TeamLeadAgent } from '../agents/teamLeadAgent';
import { ROLE_DEFINITIONS } from '../agents/roles/roleDefinitions';
import { MessageBus } from '../communication/messageBus';
import { FileManager } from '../fileops/fileManager';
import { TaskBoard } from '../orchestration/taskBoard';
import {
  LLMService,
  Message,
  MessageType,
  TaskStatus,
} from '../types';

function createMockLLM(responseContent = '<action type="complete">Done</action>'): LLMService {
  return {
    modelName: 'test-model',
    sendMessages: vi.fn().mockResolvedValue(responseContent),
    streamMessages: vi.fn(),
  };
}

describe('TeamLeadAgent - Blocker Handling & Result Storage', () => {
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
    teamLead.start();
  });

  afterEach(() => {
    teamLead.dispose();
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
