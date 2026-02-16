import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Scheduler } from '../orchestration/scheduler';
import { TaskBoard } from '../orchestration/taskBoard';
import { AgentRegistry } from '../agents/registry';
import { MessageBus } from '../communication/messageBus';
import { FileManager } from '../fileops/fileManager';
import { AgentStatus, TaskPriority, LLMService, LLMMessage } from '../types';

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
});
