import * as vscode from 'vscode';
import { AgentStatus, Task, TaskStatus } from '../types';
import { Agent } from '../agents/agent';
import { AgentRegistry } from '../agents/registry';
import { TaskBoard } from './taskBoard';

/**
 * The scheduler pulls ready tasks from the TaskBoard and assigns them
 * to idle agents, respecting dependency order and parallelism limits.
 * It runs as a polling loop while the team is active.
 */
export class Scheduler {
  private isRunning = false;
  private isPaused = false;
  private isTicking = false;
  private schedulerInterval: ReturnType<typeof setInterval> | null = null;
  private activeExecutions: Map<string, Promise<void>> = new Map();
  private outputChannel: vscode.OutputChannel;

  constructor(
    private readonly agentRegistry: AgentRegistry,
    private readonly taskBoard: TaskBoard,
    private readonly maxParallel: number,
    private readonly maxIterationsPerTask: number = 50
  ) {
    this.outputChannel = vscode.window.createOutputChannel(
      'DevCrew: Scheduler'
    );
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.log('Scheduler started');

    // Poll for ready tasks every 2 seconds
    this.schedulerInterval = setInterval(() => this.tick(), 2000);

    // Also react immediately when tasks change
    this.taskBoard.onTaskChange(() => {
      if (this.isRunning) this.tick();
    });
  }

  stop(): void {
    this.isRunning = false;
    this.isPaused = false;
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }
    this.log('Scheduler stopped');
  }

  /**
   * Pause dispatching. Running executions continue but no new tasks
   * will be dispatched. Active tasks are paused on the board.
   */
  pause(): void {
    if (!this.isRunning || this.isPaused) return;
    this.isPaused = true;

    // Pause all active tasks on the board
    const pausedCount = this.taskBoard.pauseActiveTasks();
    this.log(`Scheduler paused (${pausedCount} tasks paused, ${this.activeExecutions.size} executions still in flight)`);
  }

  /**
   * Resume dispatching. Paused and failed tasks are moved back to Pending.
   */
  resume(): void {
    if (!this.isRunning || !this.isPaused) return;
    this.isPaused = false;

    const resumedCount = this.taskBoard.resumePausedTasks(true);
    this.log(`Scheduler resumed (${resumedCount} tasks requeued)`);

    // Immediately try to dispatch
    this.tick();
  }

  getIsPaused(): boolean {
    return this.isPaused;
  }

  private tick(): void {
    // Guard against reentrant calls from onTaskChange during dispatch
    if (this.isTicking) return;
    this.isTicking = true;

    try {
      this.tickInner();
    } finally {
      this.isTicking = false;
    }
  }

  private tickInner(): void {
    if (this.isPaused) return;
    if (this.activeExecutions.size >= this.maxParallel) return;

    const readyTasks = this.taskBoard.getReadyTasks();
    if (readyTasks.length === 0) return;

    readyTasks.sort((a, b) => a.priority - b.priority);

    for (const task of readyTasks) {
      if (this.activeExecutions.size >= this.maxParallel) break;

      if (!task.assigneeId) {
        this.log(`Warning: task "${task.title}" has no assignee, skipping`);
        continue;
      }

      const agent = this.agentRegistry.getAgent(task.assigneeId);
      if (!agent) {
        this.log(`Warning: agent ${task.assigneeId} not found for task "${task.title}"`);
        continue;
      }

      if (agent.getState().status !== AgentStatus.Idle) continue;

      this.dispatch(agent, task);
    }
  }

  private enrichTaskWithDependencies(task: Task): Task {
    if (task.dependsOn.length === 0) return task;

    const results: Array<{
      taskId: string;
      title: string;
      summary: string;
      filesWritten?: string[];
    }> = [];
    for (const depId of task.dependsOn) {
      const dep = this.taskBoard.getTask(depId);
      if (dep?.status === TaskStatus.Completed && dep.metadata['completionSummary']) {
        results.push({
          taskId: dep.id,
          title: dep.title,
          summary: dep.metadata['completionSummary'] as string,
          filesWritten: dep.metadata['filesWritten'] as string[] | undefined,
        });
      }
    }

    if (results.length === 0) return task;

    return {
      ...task,
      metadata: {
        ...task.metadata,
        dependencyResults: results,
      },
    };
  }

  private dispatch(agent: Agent, task: Task): void {
    this.log(`Dispatching "${task.title}" to ${agent.roleConfig.name}`);

    this.taskBoard.assignTask(task.id, agent.id);
    this.taskBoard.startTask(task.id);

    const enrichedTask = this.enrichTaskWithDependencies(task);

    const execution = agent
      .executeTask(enrichedTask, this.maxIterationsPerTask)
      .then((summary) => {
        // Only mark complete if still InProgress (guards against Paused and Cancelled)
        const current = this.taskBoard.getTask(task.id);
        if (current && current.status === TaskStatus.InProgress) {
          this.taskBoard.completeTask(task.id, summary);
          this.log(`Task "${task.title}" completed by ${agent.roleConfig.name}`);
        }
      })
      .catch((err) => {
        // Only mark failed if still InProgress (guards against Paused and Cancelled)
        const current = this.taskBoard.getTask(task.id);
        if (current && current.status === TaskStatus.InProgress) {
          this.taskBoard.failTask(task.id);
        }
        this.log(
          `Task "${task.title}" failed: ${err instanceof Error ? err.message : err}`
        );
      })
      .finally(() => {
        this.activeExecutions.delete(task.id);
      });

    this.activeExecutions.set(task.id, execution);
  }

  getActiveCount(): number {
    return this.activeExecutions.size;
  }

  private log(message: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    this.outputChannel.appendLine(`[${ts}] ${message}`);
  }

  dispose(): void {
    this.stop();
    this.outputChannel.dispose();
  }
}
