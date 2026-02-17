import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskBoard } from '../orchestration/taskBoard';
import { Scheduler } from '../orchestration/scheduler';
import { AgentRegistry } from '../agents/registry';
import { SpecialistAgent } from '../agents/specialistAgent';
import { TeamLeadAgent } from '../agents/teamLeadAgent';
import { ROLE_DEFINITIONS } from '../agents/roles/roleDefinitions';
import { MessageBus } from '../communication/messageBus';
import { FileManager } from '../fileops/fileManager';
import {
  AgentStatus,
  LLMService,
  TaskPriority,
  TaskStatus,
  Task,
} from '../types';

function createMockLLM(): LLMService {
  const sendMessages = vi
    .fn()
    .mockResolvedValue('<action type="complete">Done</action>');
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

// ─── TaskBoard Pause/Resume ───────────────────────────────────────────────────

describe('TaskBoard - Pause/Resume', () => {
  let board: TaskBoard;

  beforeEach(() => {
    board = new TaskBoard();
  });

  describe('pauseTask', () => {
    it('transitions a task to Paused status', () => {
      const task = board.createTask({ title: 'T', description: 'd' });
      board.startTask(task.id);

      const paused = board.pauseTask(task.id);
      expect(paused?.status).toBe(TaskStatus.Paused);
    });

    it('stores the pre-pause status in metadata', () => {
      const task = board.createTask({ title: 'T', description: 'd' });
      board.startTask(task.id);

      board.pauseTask(task.id);
      const updated = board.getTask(task.id)!;
      expect(updated.metadata['statusBeforePause']).toBe(
        TaskStatus.InProgress
      );
    });

    it('returns undefined for non-existent task', () => {
      expect(board.pauseTask('fake-id')).toBeUndefined();
    });
  });

  describe('resumeTask', () => {
    it('transitions a paused task back to Pending', () => {
      const task = board.createTask({ title: 'T', description: 'd' });
      board.startTask(task.id);
      board.pauseTask(task.id);

      const resumed = board.resumeTask(task.id);
      expect(resumed?.status).toBe(TaskStatus.Pending);
    });

    it('clears the assigneeId so scheduler can re-dispatch', () => {
      const task = board.createTask({
        title: 'T',
        description: 'd',
        assigneeId: 'agent-1',
      });
      board.startTask(task.id);
      board.pauseTask(task.id);

      const resumed = board.resumeTask(task.id);
      expect(resumed?.assigneeId).toBeNull();
    });

    it('does nothing if task is not paused', () => {
      const task = board.createTask({ title: 'T', description: 'd' });
      expect(board.resumeTask(task.id)).toBeUndefined();
    });

    it('returns undefined for non-existent task', () => {
      expect(board.resumeTask('fake-id')).toBeUndefined();
    });
  });

  describe('pauseActiveTasks', () => {
    it('pauses all active (Pending, Assigned, InProgress, Blocked) tasks', () => {
      const t1 = board.createTask({ title: 'Pending', description: 'p' });
      const t2 = board.createTask({ title: 'Assigned', description: 'a' });
      const t3 = board.createTask({ title: 'InProgress', description: 'i' });
      const t4 = board.createTask({ title: 'Blocked', description: 'b' });
      const t5 = board.createTask({ title: 'Completed', description: 'c' });

      board.assignTask(t2.id, 'agent-1');
      board.startTask(t3.id);
      board.blockTask(t4.id);
      board.completeTask(t5.id);

      const count = board.pauseActiveTasks();

      expect(count).toBe(4);
      expect(board.getTask(t1.id)!.status).toBe(TaskStatus.Paused);
      expect(board.getTask(t2.id)!.status).toBe(TaskStatus.Paused);
      expect(board.getTask(t3.id)!.status).toBe(TaskStatus.Paused);
      expect(board.getTask(t4.id)!.status).toBe(TaskStatus.Paused);
      // Completed task should NOT be paused
      expect(board.getTask(t5.id)!.status).toBe(TaskStatus.Completed);
    });

    it('returns 0 when no tasks are pausable', () => {
      const t1 = board.createTask({ title: 'Done', description: 'd' });
      board.completeTask(t1.id);

      expect(board.pauseActiveTasks()).toBe(0);
    });
  });

  describe('resumePausedTasks', () => {
    it('resumes all paused tasks', () => {
      const t1 = board.createTask({ title: 'A', description: 'a' });
      const t2 = board.createTask({ title: 'B', description: 'b' });
      board.pauseTask(t1.id);
      board.pauseTask(t2.id);

      const count = board.resumePausedTasks(false);

      expect(count).toBe(2);
      expect(board.getTask(t1.id)!.status).toBe(TaskStatus.Pending);
      expect(board.getTask(t2.id)!.status).toBe(TaskStatus.Pending);
    });

    it('also recovers failed tasks when alsoRecoverFailed=true', () => {
      const t1 = board.createTask({ title: 'Paused', description: 'p' });
      const t2 = board.createTask({ title: 'Failed', description: 'f' });
      board.pauseTask(t1.id);
      board.failTask(t2.id);

      const count = board.resumePausedTasks(true);

      expect(count).toBe(2);
      expect(board.getTask(t1.id)!.status).toBe(TaskStatus.Pending);
      expect(board.getTask(t2.id)!.status).toBe(TaskStatus.Pending);
    });

    it('does not recover failed tasks when alsoRecoverFailed=false', () => {
      const t1 = board.createTask({ title: 'Paused', description: 'p' });
      const t2 = board.createTask({ title: 'Failed', description: 'f' });
      board.pauseTask(t1.id);
      board.failTask(t2.id);

      const count = board.resumePausedTasks(false);

      expect(count).toBe(1);
      expect(board.getTask(t1.id)!.status).toBe(TaskStatus.Pending);
      expect(board.getTask(t2.id)!.status).toBe(TaskStatus.Failed);
    });
  });

  describe('getPausedTasks', () => {
    it('returns only paused tasks', () => {
      const t1 = board.createTask({ title: 'A', description: 'a' });
      const t2 = board.createTask({ title: 'B', description: 'b' });
      board.pauseTask(t1.id);

      const paused = board.getPausedTasks();
      expect(paused).toHaveLength(1);
      expect(paused[0].id).toBe(t1.id);
    });
  });

  describe('getStats includes paused count', () => {
    it('counts paused tasks in stats', () => {
      const t1 = board.createTask({ title: 'A', description: 'a' });
      const t2 = board.createTask({ title: 'B', description: 'b' });
      board.pauseTask(t1.id);

      const stats = board.getStats();
      expect(stats.paused).toBe(1);
      expect(stats.pending).toBe(1);
    });
  });
});

// ─── Agent Pause/Resume ──────────────────────────────────────────────────────

describe('Agent - Pause/Resume', () => {
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

  it('pause sets agent status to Paused', () => {
    agent.start();
    agent.pause();
    expect(agent.getState().status).toBe(AgentStatus.Paused);
  });

  it('pause clears currentTaskId', () => {
    agent.start();
    // Simulate having a task
    (agent as any).state.currentTaskId = 'task-123';
    agent.pause();
    expect(agent.getState().currentTaskId).toBeNull();
  });

  it('resume sets agent status to Idle', () => {
    agent.start();
    agent.pause();
    agent.resume();
    expect(agent.getState().status).toBe(AgentStatus.Idle);
  });

  it('resume also works from Error state', () => {
    agent.start();
    (agent as any).setStatus(AgentStatus.Error);
    agent.resume();
    expect(agent.getState().status).toBe(AgentStatus.Idle);
  });

  it('resume is a no-op for non-paused/non-error agent', () => {
    agent.start();
    // Agent is Idle
    agent.resume();
    // Should remain Idle (no error thrown)
    expect(agent.getState().status).toBe(AgentStatus.Idle);
  });

  it('resume clears blockerDescription', () => {
    agent.start();
    (agent as any).state.blockerDescription = 'some blocker';
    agent.pause();
    agent.resume();
    expect(agent.getState().blockerDescription).toBeNull();
  });

  it('fires onStateChange for pause and resume', () => {
    const listener = vi.fn();
    agent.onStateChange(listener);

    agent.start();
    agent.pause();
    agent.resume();

    const statuses = listener.mock.calls.map(
      (call: any[]) => call[0].status
    );
    expect(statuses).toContain(AgentStatus.Paused);
    expect(statuses).toContain(AgentStatus.Idle);
  });
});

// ─── TeamLeadAgent Pause/Resume ──────────────────────────────────────────────

describe('TeamLeadAgent - Pause/Resume', () => {
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

  it('pause stops the monitoring loop', () => {
    teamLead.start();
    // Start monitoring by setting up tasks
    (teamLead as any).startMonitoring();
    expect((teamLead as any).monitorInterval).not.toBeNull();

    teamLead.pause();
    expect((teamLead as any).monitorInterval).toBeNull();
    expect(teamLead.getState().status).toBe(AgentStatus.Paused);
  });

  it('resume restarts monitoring when outstanding tasks exist', () => {
    teamLead.start();
    taskBoard.createTask({ title: 'Work', description: 'work' });

    teamLead.pause();
    teamLead.resume();

    expect(teamLead.getState().status).toBe(AgentStatus.Idle);
    expect((teamLead as any).monitorInterval).not.toBeNull();

    // Cleanup
    teamLead.dispose();
  });

  it('resume does not restart monitoring if all tasks are done', () => {
    teamLead.start();
    const t = taskBoard.createTask({ title: 'Work', description: 'work' });
    taskBoard.completeTask(t.id);

    teamLead.pause();
    teamLead.resume();

    expect((teamLead as any).monitorInterval).toBeNull();
  });
});

// ─── AgentRegistry pauseAll/resumeAll ────────────────────────────────────────

describe('AgentRegistry - pauseAll/resumeAll', () => {
  let messageBus: MessageBus;
  let fileManager: FileManager;
  let taskBoard: TaskBoard;
  let mockLLM: LLMService;
  let registry: AgentRegistry;

  beforeEach(() => {
    messageBus = new MessageBus();
    fileManager = new FileManager(false, false);
    taskBoard = new TaskBoard();
    mockLLM = createMockLLM();
    registry = new AgentRegistry(messageBus, fileManager, taskBoard, mockLLM);
    registry.buildTeam();
    registry.createAgent(ROLE_DEFINITIONS['frontend']);
    registry.createAgent(ROLE_DEFINITIONS['backend']);
  });

  afterEach(() => {
    registry.dispose();
    messageBus.dispose();
    taskBoard.dispose();
    fileManager.dispose();
  });

  it('pauseAll pauses every agent', () => {
    registry.pauseAll();

    for (const agent of registry.getAllAgents()) {
      expect(agent.getState().status).toBe(AgentStatus.Paused);
    }
  });

  it('resumeAll resumes every paused agent', () => {
    registry.pauseAll();
    registry.resumeAll();

    for (const agent of registry.getAllAgents()) {
      expect(agent.getState().status).toBe(AgentStatus.Idle);
    }
  });
});

// ─── Scheduler Pause/Resume ──────────────────────────────────────────────────

describe('Scheduler - Pause/Resume', () => {
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
    registry.buildTeam();
    registry.createAgent(ROLE_DEFINITIONS['frontend']);
    registry.createAgent(ROLE_DEFINITIONS['backend']);
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

  it('pause sets isPaused flag', () => {
    scheduler.start();
    scheduler.pause();
    expect(scheduler.getIsPaused()).toBe(true);
  });

  it('resume clears isPaused flag', () => {
    scheduler.start();
    scheduler.pause();
    scheduler.resume();
    expect(scheduler.getIsPaused()).toBe(false);
  });

  it('pause is a no-op when not running', () => {
    scheduler.pause();
    expect(scheduler.getIsPaused()).toBe(false);
  });

  it('resume is a no-op when not paused', () => {
    scheduler.start();
    scheduler.resume(); // not paused
    expect(scheduler.getIsPaused()).toBe(false);
  });

  it('does not dispatch tasks while paused', async () => {
    taskBoard.createTask({
      title: 'Work',
      description: 'do stuff',
      priority: TaskPriority.High,
    });

    scheduler.start();
    scheduler.pause();

    // Advance timer past multiple ticks
    vi.advanceTimersByTime(10000);
    await vi.advanceTimersByTimeAsync(100);

    // All tasks should be paused, none dispatched
    expect(scheduler.getActiveCount()).toBe(0);
  });

  it('pause pauses active tasks on the board', () => {
    const t1 = taskBoard.createTask({ title: 'A', description: 'a' });
    const t2 = taskBoard.createTask({ title: 'B', description: 'b' });
    taskBoard.startTask(t1.id);

    scheduler.start();
    scheduler.pause();

    expect(taskBoard.getTask(t1.id)!.status).toBe(TaskStatus.Paused);
    expect(taskBoard.getTask(t2.id)!.status).toBe(TaskStatus.Paused);
  });

  it('resume re-queues paused and failed tasks', () => {
    // Create more tasks than agents so some remain pending after dispatch
    const t1 = taskBoard.createTask({ title: 'A', description: 'a' });
    const t2 = taskBoard.createTask({ title: 'B', description: 'b' });
    taskBoard.pauseTask(t1.id);
    taskBoard.failTask(t2.id);

    // Don't start the scheduler — just test the board-level resume logic
    // through the scheduler's resume method with dispatch suppressed
    scheduler.start();
    (scheduler as any).isPaused = true;

    // Use a slow LLM so tasks stay in dispatched state if picked up
    (mockLLM.sendMessages as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<string>(() => {}) // never resolves
    );

    scheduler.resume();

    // After resume, tasks should be Pending or already dispatched (Assigned/InProgress).
    // The key assertion: they are no longer Paused/Failed.
    const s1 = taskBoard.getTask(t1.id)!.status;
    const s2 = taskBoard.getTask(t2.id)!.status;
    expect(s1).not.toBe(TaskStatus.Paused);
    expect(s2).not.toBe(TaskStatus.Failed);
  });

  it('stop resets isPaused', () => {
    scheduler.start();
    scheduler.pause();
    scheduler.stop();
    expect(scheduler.getIsPaused()).toBe(false);
  });
});
