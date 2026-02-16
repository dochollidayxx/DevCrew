import * as vscode from 'vscode';
import { Task, TaskStatus, TaskPriority } from '../types';

/**
 * Central task management system. Tracks all tasks, their status,
 * dependencies, and assignments. The Team Lead creates tasks here
 * and the scheduler pulls from it.
 */
export class TaskBoard {
  private tasks: Map<string, Task> = new Map();

  private readonly _onTaskChange = new vscode.EventEmitter<Task>();
  readonly onTaskChange = this._onTaskChange.event;

  private readonly _onTaskAdded = new vscode.EventEmitter<Task>();
  readonly onTaskAdded = this._onTaskAdded.event;

  // ─── Task CRUD ──────────────────────────────────────────────────────

  createTask(params: {
    title: string;
    description: string;
    priority?: TaskPriority;
    dependsOn?: string[];
    parentTaskId?: string | null;
    assigneeId?: string | null;
    files?: Task['files'];
  }): Task {
    const task: Task = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: params.title,
      description: params.description,
      status: TaskStatus.Pending,
      priority: params.priority ?? TaskPriority.Medium,
      assigneeId: params.assigneeId ?? null,
      dependsOn: params.dependsOn ?? [],
      blockedBy: [],
      subtasks: [],
      parentTaskId: params.parentTaskId ?? null,
      files: params.files ?? [],
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
      metadata: {},
    };

    this.tasks.set(task.id, task);

    // If this is a subtask, register it with the parent
    if (task.parentTaskId) {
      const parent = this.tasks.get(task.parentTaskId);
      if (parent) {
        parent.subtasks.push(task.id);
        this.fireChange(parent);
      }
    }

    this._onTaskAdded.fire(task);
    return task;
  }

  updateTask(taskId: string, updates: Partial<Task>): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    Object.assign(task, updates, { updatedAt: new Date() });

    if (updates.status === TaskStatus.Completed) {
      task.completedAt = new Date();
    }

    this.fireChange(task);
    return task;
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  // ─── Queries ────────────────────────────────────────────────────────

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  getTasksByStatus(status: TaskStatus): Task[] {
    return this.getAllTasks().filter((t) => t.status === status);
  }

  getTasksByAssignee(agentId: string): Task[] {
    return this.getAllTasks().filter((t) => t.assigneeId === agentId);
  }

  getReadyTasks(): Task[] {
    return this.getAllTasks().filter((task) => {
      if (task.status !== TaskStatus.Pending) return false;

      // Check all dependencies are completed
      return task.dependsOn.every((depId) => {
        const dep = this.tasks.get(depId);
        return dep?.status === TaskStatus.Completed;
      });
    });
  }

  getBlockedTasks(): Task[] {
    return this.getTasksByStatus(TaskStatus.Blocked);
  }

  getRootTasks(): Task[] {
    return this.getAllTasks().filter((t) => t.parentTaskId === null);
  }

  // ─── Dependency Management ──────────────────────────────────────────

  addDependency(taskId: string, dependsOnId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    // Prevent circular dependencies
    if (this.wouldCreateCycle(taskId, dependsOnId)) {
      return false;
    }

    if (!task.dependsOn.includes(dependsOnId)) {
      task.dependsOn.push(dependsOnId);
      this.fireChange(task);
    }

    return true;
  }

  private wouldCreateCycle(taskId: string, newDepId: string): boolean {
    // BFS to check if newDepId can reach taskId through dependencies
    const visited = new Set<string>();
    const queue = [newDepId];

    // If the new dependency IS the task, that's a self-cycle
    if (taskId === newDepId) return true;

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      const currentTask = this.tasks.get(current);
      if (!currentTask) continue;

      for (const depId of currentTask.dependsOn) {
        if (depId === taskId) return true;
        queue.push(depId);
      }
    }

    return false;
  }

  areDependenciesMet(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    return task.dependsOn.every((depId) => {
      const dep = this.tasks.get(depId);
      return dep?.status === TaskStatus.Completed;
    });
  }

  // ─── Assignment ─────────────────────────────────────────────────────

  assignTask(taskId: string, agentId: string): Task | undefined {
    return this.updateTask(taskId, {
      assigneeId: agentId,
      status: TaskStatus.Assigned,
    });
  }

  startTask(taskId: string): Task | undefined {
    return this.updateTask(taskId, { status: TaskStatus.InProgress });
  }

  completeTask(taskId: string): Task | undefined {
    const task = this.updateTask(taskId, { status: TaskStatus.Completed });

    // Check if completing this task unblocks others
    if (task) {
      for (const otherTask of this.tasks.values()) {
        if (
          otherTask.status === TaskStatus.Pending &&
          otherTask.dependsOn.includes(taskId)
        ) {
          if (this.areDependenciesMet(otherTask.id)) {
            // Task is now ready to be picked up
            this.fireChange(otherTask);
          }
        }
      }
    }

    return task;
  }

  failTask(taskId: string): Task | undefined {
    return this.updateTask(taskId, { status: TaskStatus.Failed });
  }

  blockTask(taskId: string, blockedByTaskId?: string): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    if (blockedByTaskId && !task.blockedBy.includes(blockedByTaskId)) {
      task.blockedBy.push(blockedByTaskId);
    }

    return this.updateTask(taskId, { status: TaskStatus.Blocked });
  }

  // ─── Pause / Resume ──────────────────────────────────────────────

  pauseTask(taskId: string): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    // Store the pre-pause status so we can restore on resume
    task.metadata['statusBeforePause'] = task.status;
    return this.updateTask(taskId, { status: TaskStatus.Paused });
  }

  resumeTask(taskId: string): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== TaskStatus.Paused) return undefined;

    // Revert to Pending so the scheduler can re-dispatch it cleanly.
    // Clear assignee so the scheduler picks the best available agent.
    return this.updateTask(taskId, {
      status: TaskStatus.Pending,
      assigneeId: null,
    });
  }

  /**
   * Pause all tasks that are currently in-flight (Assigned, InProgress)
   * or waiting to run (Pending). Returns the count of paused tasks.
   */
  pauseActiveTasks(): number {
    const pausable: TaskStatus[] = [
      TaskStatus.Pending,
      TaskStatus.Assigned,
      TaskStatus.InProgress,
      TaskStatus.Blocked,
    ];

    let count = 0;
    for (const task of this.tasks.values()) {
      if (pausable.includes(task.status)) {
        this.pauseTask(task.id);
        count++;
      }
    }
    return count;
  }

  /**
   * Resume all paused tasks, plus optionally recover tasks that failed
   * (e.g. due to network errors) so they get another chance.
   */
  resumePausedTasks(alsoRecoverFailed = true): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === TaskStatus.Paused) {
        this.resumeTask(task.id);
        count++;
      } else if (alsoRecoverFailed && task.status === TaskStatus.Failed) {
        this.updateTask(task.id, {
          status: TaskStatus.Pending,
          assigneeId: null,
        });
        count++;
      }
    }
    return count;
  }

  getPausedTasks(): Task[] {
    return this.getTasksByStatus(TaskStatus.Paused);
  }

  // ─── Statistics ─────────────────────────────────────────────────────

  getStats(): {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
    blocked: number;
    paused: number;
  } {
    const all = this.getAllTasks();
    return {
      total: all.length,
      pending: all.filter((t) => t.status === TaskStatus.Pending).length,
      inProgress: all.filter(
        (t) =>
          t.status === TaskStatus.InProgress ||
          t.status === TaskStatus.Assigned
      ).length,
      completed: all.filter((t) => t.status === TaskStatus.Completed).length,
      failed: all.filter((t) => t.status === TaskStatus.Failed).length,
      blocked: all.filter((t) => t.status === TaskStatus.Blocked).length,
      paused: all.filter((t) => t.status === TaskStatus.Paused).length,
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private fireChange(task: Task): void {
    this._onTaskChange.fire(task);
  }

  clear(): void {
    this.tasks.clear();
  }

  dispose(): void {
    this._onTaskChange.dispose();
    this._onTaskAdded.dispose();
  }
}
