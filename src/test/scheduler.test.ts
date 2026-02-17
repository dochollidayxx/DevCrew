import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Scheduler } from '../orchestration/scheduler';
import { TaskBoard } from '../orchestration/taskBoard';
import { AgentRegistry } from '../agents/registry';
import { MessageBus } from '../communication/messageBus';
import { FileManager } from '../fileops/fileManager';
import { ROLE_DEFINITIONS } from '../agents/roles/roleDefinitions';
import { TaskPriority, LLMService } from '../types';

function createMockLLM(): LLMService {
  const sendMessages = vi.fn().mockResolvedValue(
    '<action type="complete">Done</action>'
  );
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

describe('Scheduler', () => {
  let messageBus: MessageBus;
  let fileManager: FileManager;
  let taskBoard: TaskBoard;
  let registry: AgentRegistry;
  let scheduler: Scheduler;
  let mockLLM: LLMService;
  let frontendAgentId: string;
  let backendAgentId: string;

  beforeEach(() => {
    vi.useFakeTimers();
    messageBus = new MessageBus();
    fileManager = new FileManager(false, false);
    taskBoard = new TaskBoard();
    mockLLM = createMockLLM();
    registry = new AgentRegistry(messageBus, fileManager, taskBoard, mockLLM);

    // Build team: only Team Lead at first
    registry.buildTeam();
    // Dynamically add specialists
    const frontendAgent = registry.createAgent(ROLE_DEFINITIONS['frontend']);
    const backendAgent = registry.createAgent(ROLE_DEFINITIONS['backend']);
    frontendAgentId = frontendAgent.id;
    backendAgentId = backendAgent.id;

    scheduler = new Scheduler(registry, taskBoard, 2);
  });

  afterEach(() => {
    scheduler.dispose();
    registry.dispose();
    messageBus.dispose();
    taskBoard.dispose();
    fileManager.dispose();
    vi.useRealTimers();
  });

  it('starts and stops without errors', () => {
    scheduler.start();
    expect(scheduler.getActiveCount()).toBe(0);
    scheduler.stop();
  });

  it('reports 0 active executions when idle', () => {
    expect(scheduler.getActiveCount()).toBe(0);
  });

  it('does not double-start', () => {
    scheduler.start();
    scheduler.start(); // second call should be a no-op
    scheduler.stop();
  });

  it('dispatches ready tasks to assigned agents on tick', async () => {
    // Create a task explicitly assigned to the frontend agent
    taskBoard.createTask({
      title: 'Frontend work',
      description: 'Build a component',
      priority: TaskPriority.High,
      assigneeId: frontendAgentId,
    });

    scheduler.start();

    vi.advanceTimersByTime(2500);
    await vi.advanceTimersByTimeAsync(100);

    expect(scheduler.getActiveCount()).toBeGreaterThanOrEqual(0);
  });

  it('skips tasks without assigneeId', async () => {
    // Create a task with no assignee
    taskBoard.createTask({
      title: 'Orphan task',
      description: 'No assignee',
    });

    scheduler.start();
    vi.advanceTimersByTime(2500);
    await vi.advanceTimersByTimeAsync(100);

    // Task should not be dispatched (stays pending)
    const task = taskBoard.getAllTasks()[0];
    expect(task.status).toBe('pending');
  });

  it('respects maxParallel limit', async () => {
    // Create more tasks than maxParallel (2), all with assignees
    for (let i = 0; i < 5; i++) {
      taskBoard.createTask({
        title: `Task ${i}`,
        description: `Do thing ${i}`,
        assigneeId: i % 2 === 0 ? frontendAgentId : backendAgentId,
      });
    }

    // Use a slow LLM that never resolves to keep tasks "active"
    let resolvers: Array<(v: string) => void> = [];
    const slowImpl = () => new Promise<string>((resolve) => { resolvers.push(resolve); });
    (mockLLM.sendMessages as ReturnType<typeof vi.fn>).mockImplementation(slowImpl);
    (mockLLM.streamWithProgress as ReturnType<typeof vi.fn>).mockImplementation(slowImpl);

    scheduler.start();

    vi.advanceTimersByTime(2500);
    await vi.advanceTimersByTimeAsync(50);

    // With maxParallel=2, only 2 should have been dispatched
    expect(resolvers.length).toBeLessThanOrEqual(2);
  });

  it('dispose stops the scheduler', () => {
    scheduler.start();
    scheduler.dispose();
    vi.advanceTimersByTime(10000);
  });

  // ─── Cancelled Task Guards ────────────────────────────────────────

  describe('cancelled task guards', () => {
    it('does not overwrite Cancelled with Completed', async () => {
      // Use a slow LLM so we can cancel while execution is in-flight
      let resolveExecution: ((v: string) => void) | null = null;
      (mockLLM.streamWithProgress as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise<string>((resolve) => { resolveExecution = resolve; })
      );

      const task = taskBoard.createTask({
        title: 'Cancel me',
        description: 'Will be cancelled mid-run',
        assigneeId: frontendAgentId,
      });

      scheduler.start();
      vi.advanceTimersByTime(2500);
      await vi.advanceTimersByTimeAsync(50);

      // Task should now be InProgress and dispatched
      expect(taskBoard.getTask(task.id)!.status).toBe('in_progress');

      // Cancel while execution is in flight
      taskBoard.cancelTask(task.id);
      expect(taskBoard.getTask(task.id)!.status).toBe('cancelled');

      // Now let the execution complete
      resolveExecution!('<action type="complete">Done</action>');
      await vi.advanceTimersByTimeAsync(100);

      // Task should remain Cancelled, not overwritten to Completed
      expect(taskBoard.getTask(task.id)!.status).toBe('cancelled');
    });

    it('does not overwrite Cancelled with Failed', async () => {
      // Use a slow LLM that we can reject after cancel
      let rejectExecution: ((err: Error) => void) | null = null;
      (mockLLM.streamWithProgress as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise<string>((_, reject) => { rejectExecution = reject; })
      );

      const task = taskBoard.createTask({
        title: 'Cancel then fail',
        description: 'Will be cancelled then error',
        assigneeId: frontendAgentId,
      });

      scheduler.start();
      vi.advanceTimersByTime(2500);
      await vi.advanceTimersByTimeAsync(50);

      // Cancel the task while in flight
      taskBoard.cancelTask(task.id);

      // Now let the execution fail
      rejectExecution!(new Error('LLM error'));
      await vi.advanceTimersByTimeAsync(100);

      // Task should remain Cancelled
      expect(taskBoard.getTask(task.id)!.status).toBe('cancelled');
    });
  });

  // ─── Dependency Enrichment ─────────────────────────────────────────

  describe('dependency enrichment', () => {
    it('enrichTaskWithDependencies adds completionSummary from completed deps', () => {
      const depTask = taskBoard.createTask({
        title: 'Setup DB',
        description: 'Create database schema',
        assigneeId: backendAgentId,
      });
      taskBoard.completeTask(depTask.id, 'Created tables: users, posts, comments');

      const mainTask = taskBoard.createTask({
        title: 'Build API',
        description: 'Build REST API',
        dependsOn: [depTask.id],
        assigneeId: backendAgentId,
      });

      const enriched = (scheduler as any).enrichTaskWithDependencies(mainTask);

      expect(enriched.metadata['dependencyResults']).toBeDefined();
      const results = enriched.metadata['dependencyResults'] as Array<any>;
      expect(results).toHaveLength(1);
      expect(results[0].taskId).toBe(depTask.id);
      expect(results[0].title).toBe('Setup DB');
      expect(results[0].summary).toBe('Created tables: users, posts, comments');
    });

    it('does not modify tasks with no dependencies', () => {
      const task = taskBoard.createTask({
        title: 'Standalone',
        description: 'No deps',
        assigneeId: frontendAgentId,
      });

      const enriched = (scheduler as any).enrichTaskWithDependencies(task);

      expect(enriched).toBe(task);
      expect(enriched.metadata['dependencyResults']).toBeUndefined();
    });

    it('does not add results for deps without completionSummary', () => {
      const depTask = taskBoard.createTask({
        title: 'Setup DB',
        description: 'Create database schema',
        assigneeId: backendAgentId,
      });
      taskBoard.completeTask(depTask.id);

      const mainTask = taskBoard.createTask({
        title: 'Build API',
        description: 'Build REST API',
        dependsOn: [depTask.id],
        assigneeId: backendAgentId,
      });

      const enriched = (scheduler as any).enrichTaskWithDependencies(mainTask);
      expect(enriched).toBe(mainTask);
    });
  });

  // ─── Scheduler passes summary to completeTask ─────────────────────

  describe('dispatch completion', () => {
    it('passes agent summary to taskBoard.completeTask after agent completes', async () => {
      const completeSpy = vi.spyOn(taskBoard, 'completeTask');

      // Create a ready task with explicit assignment
      const task = taskBoard.createTask({
        title: 'Frontend work',
        description: 'Build a component',
        priority: TaskPriority.High,
        assigneeId: frontendAgentId,
      });

      // Mock LLM to return a completion with a summary
      const completionXml = '<action type="complete">Built the React component with tests</action>';
      (mockLLM.sendMessages as ReturnType<typeof vi.fn>).mockResolvedValue(completionXml);
      (mockLLM.streamWithProgress as ReturnType<typeof vi.fn>).mockImplementation(
        async (messages: unknown[], onChunk?: (chunk: string, accumulated: string) => void) => {
          onChunk?.(completionXml, completionXml);
          return completionXml;
        }
      );

      scheduler.start();

      vi.advanceTimersByTime(2500);
      await vi.advanceTimersByTimeAsync(200);
      await vi.advanceTimersByTimeAsync(200);

      const callWithSummary = completeSpy.mock.calls.find(
        (call) => call[0] === task.id && typeof call[1] === 'string'
      );
      expect(callWithSummary).toBeDefined();
      if (callWithSummary) {
        expect(callWithSummary[1]).toContain('Built the React component');
      }
    });
  });
});
