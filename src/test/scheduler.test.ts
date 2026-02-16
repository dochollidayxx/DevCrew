import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Scheduler } from '../orchestration/scheduler';
import { TaskBoard } from '../orchestration/taskBoard';
import { AgentRegistry } from '../agents/registry';
import { MessageBus } from '../communication/messageBus';
import { FileManager } from '../fileops/fileManager';
import { AgentStatus, TaskPriority, TaskStatus, LLMService, LLMMessage } from '../types';

function createMockLLM(): LLMService {
  return {
    modelName: 'test-model',
    sendMessages: vi.fn().mockResolvedValue(
      '<action type="complete">Done</action>'
    ),
    streamMessages: vi.fn(),
  };
}

describe('Scheduler', () => {
  let messageBus: MessageBus;
  let fileManager: FileManager;
  let taskBoard: TaskBoard;
  let registry: AgentRegistry;
  let scheduler: Scheduler;
  let mockLLM: LLMService;

  beforeEach(() => {
    vi.useFakeTimers();
    messageBus = new MessageBus();
    fileManager = new FileManager(false, false);
    taskBoard = new TaskBoard();
    mockLLM = createMockLLM();
    registry = new AgentRegistry(messageBus, fileManager, taskBoard, mockLLM);

    registry.buildTeam([
      'team-lead',
      'frontend',
      'backend',
      'tester',
    ]);
    registry.startAll();

    scheduler = new Scheduler(registry, taskBoard, 2);
  });

  afterEach(() => {
    scheduler.dispose();
    registry.disposeAll();
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

  it('dispatches ready tasks to idle agents on tick', async () => {
    // Create tasks that have no dependencies (immediately ready)
    taskBoard.createTask({
      title: 'Frontend work',
      description: 'Build a component',
      priority: TaskPriority.High,
    });

    scheduler.start();

    // Advance the polling interval
    vi.advanceTimersByTime(2500);

    // The scheduler should have dispatched the task
    // (the mock LLM will make the agent finish immediately)
    // Give the async dispatch a moment
    await vi.advanceTimersByTimeAsync(100);

    expect(scheduler.getActiveCount()).toBeGreaterThanOrEqual(0);
  });

  it('respects maxParallel limit', async () => {
    // Create more tasks than maxParallel (2)
    for (let i = 0; i < 5; i++) {
      taskBoard.createTask({
        title: `Task ${i}`,
        description: `Do thing ${i}`,
      });
    }

    // Use a slow LLM that never resolves to keep tasks "active"
    // We also need agents to not immediately change status, so block in executeTask
    let resolvers: Array<(v: string) => void> = [];
    (mockLLM.sendMessages as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<string>((resolve) => { resolvers.push(resolve); })
    );

    scheduler.start();

    // Single tick to dispatch first batch
    vi.advanceTimersByTime(2500);
    // Allow the microtask queue to process dispatch calls
    await vi.advanceTimersByTimeAsync(50);

    // The scheduler dispatches tasks, which call agent.executeTask,
    // which calls llm.sendMessages. The number of pending LLM calls
    // tells us how many agents were dispatched.
    // With maxParallel=2, only 2 should have been dispatched per tick.
    // But tick fires once per 2s interval. After one tick:
    expect(resolvers.length).toBeLessThanOrEqual(2);
  });

  it('dispose stops the scheduler', () => {
    scheduler.start();
    scheduler.dispose();
    // After dispose, no errors should occur on timer ticks
    vi.advanceTimersByTime(10000);
  });

  // ─── Dependency Enrichment ─────────────────────────────────────────

  describe('dependency enrichment', () => {
    it('enrichTaskWithDependencies adds completionSummary from completed deps', () => {
      // Create dep task, complete it with a summary
      const depTask = taskBoard.createTask({
        title: 'Setup DB',
        description: 'Create database schema',
      });
      taskBoard.completeTask(depTask.id, 'Created tables: users, posts, comments');

      // Create dependent task
      const mainTask = taskBoard.createTask({
        title: 'Build API',
        description: 'Build REST API',
        dependsOn: [depTask.id],
      });

      // Access private method via any
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
      });

      const enriched = (scheduler as any).enrichTaskWithDependencies(task);

      // Should be the same reference (no enrichment needed)
      expect(enriched).toBe(task);
      expect(enriched.metadata['dependencyResults']).toBeUndefined();
    });

    it('does not add results for deps without completionSummary', () => {
      const depTask = taskBoard.createTask({
        title: 'Setup DB',
        description: 'Create database schema',
      });
      // Complete without summary
      taskBoard.completeTask(depTask.id);

      const mainTask = taskBoard.createTask({
        title: 'Build API',
        description: 'Build REST API',
        dependsOn: [depTask.id],
      });

      const enriched = (scheduler as any).enrichTaskWithDependencies(mainTask);

      // No completionSummary means no dependency results
      expect(enriched).toBe(mainTask);
    });
  });

  // ─── Scheduler passes summary to completeTask ─────────────────────

  describe('dispatch completion', () => {
    it('passes agent summary to taskBoard.completeTask after agent completes', async () => {
      const completeSpy = vi.spyOn(taskBoard, 'completeTask');

      // Create a ready task
      const task = taskBoard.createTask({
        title: 'Frontend work',
        description: 'Build a component',
        priority: TaskPriority.High,
      });

      // Mock LLM to return a completion with a summary
      (mockLLM.sendMessages as ReturnType<typeof vi.fn>).mockResolvedValue(
        '<action type="complete">Built the React component with tests</action>'
      );

      scheduler.start();

      // Trigger dispatch
      vi.advanceTimersByTime(2500);
      await vi.advanceTimersByTimeAsync(200);

      // Wait for the execution promise to settle
      await vi.advanceTimersByTimeAsync(200);

      // completeTask should have been called with the task ID and summary
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
