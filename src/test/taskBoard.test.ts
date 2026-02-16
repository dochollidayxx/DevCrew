import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskBoard } from '../orchestration/taskBoard';
import { TaskStatus, TaskPriority, Task } from '../types';

describe('TaskBoard', () => {
  let board: TaskBoard;

  beforeEach(() => {
    board = new TaskBoard();
  });

  afterEach(() => {
    board.dispose();
  });

  // ─── Task CRUD ─────────────────────────────────────────────────────

  describe('createTask', () => {
    it('creates a task with defaults', () => {
      const task = board.createTask({
        title: 'Test Task',
        description: 'A test task',
      });

      expect(task.id).toMatch(/^task-/);
      expect(task.title).toBe('Test Task');
      expect(task.description).toBe('A test task');
      expect(task.status).toBe(TaskStatus.Pending);
      expect(task.priority).toBe(TaskPriority.Medium);
      expect(task.assigneeId).toBeNull();
      expect(task.dependsOn).toEqual([]);
      expect(task.subtasks).toEqual([]);
      expect(task.parentTaskId).toBeNull();
      expect(task.completedAt).toBeNull();
    });

    it('respects provided priority and assignee', () => {
      const task = board.createTask({
        title: 'High Priority',
        description: 'Urgent',
        priority: TaskPriority.Critical,
        assigneeId: 'agent-backend-123',
      });

      expect(task.priority).toBe(TaskPriority.Critical);
      expect(task.assigneeId).toBe('agent-backend-123');
    });

    it('registers subtasks with parent', () => {
      const parent = board.createTask({ title: 'Parent', description: 'p' });
      const child = board.createTask({
        title: 'Child',
        description: 'c',
        parentTaskId: parent.id,
      });

      expect(child.parentTaskId).toBe(parent.id);
      const updatedParent = board.getTask(parent.id)!;
      expect(updatedParent.subtasks).toContain(child.id);
    });

    it('fires onTaskAdded event', () => {
      const listener = vi.fn();
      board.onTaskAdded(listener);

      const task = board.createTask({ title: 'T', description: 'd' });
      expect(listener).toHaveBeenCalledWith(task);
    });
  });

  describe('updateTask', () => {
    it('updates fields and sets updatedAt', () => {
      const task = board.createTask({ title: 'T', description: 'd' });
      const before = task.updatedAt;

      // Small delay to ensure timestamp difference
      const updated = board.updateTask(task.id, { title: 'Updated Title' });

      expect(updated?.title).toBe('Updated Title');
      expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it('sets completedAt when status becomes Completed', () => {
      const task = board.createTask({ title: 'T', description: 'd' });
      const updated = board.updateTask(task.id, {
        status: TaskStatus.Completed,
      });

      expect(updated?.completedAt).toBeInstanceOf(Date);
    });

    it('returns undefined for non-existent task', () => {
      expect(board.updateTask('fake-id', { title: 'x' })).toBeUndefined();
    });

    it('fires onTaskChange event', () => {
      const listener = vi.fn();
      board.onTaskChange(listener);

      const task = board.createTask({ title: 'T', description: 'd' });
      board.updateTask(task.id, { title: 'Changed' });

      // createTask also fires change for parent registration, but updateTask fires it too
      expect(listener).toHaveBeenCalled();
    });
  });

  // ─── Queries ───────────────────────────────────────────────────────

  describe('queries', () => {
    it('getAllTasks returns all created tasks', () => {
      board.createTask({ title: 'A', description: 'a' });
      board.createTask({ title: 'B', description: 'b' });

      expect(board.getAllTasks()).toHaveLength(2);
    });

    it('getTasksByStatus filters correctly', () => {
      const t1 = board.createTask({ title: 'A', description: 'a' });
      board.createTask({ title: 'B', description: 'b' });
      board.completeTask(t1.id);

      expect(board.getTasksByStatus(TaskStatus.Completed)).toHaveLength(1);
      expect(board.getTasksByStatus(TaskStatus.Pending)).toHaveLength(1);
    });

    it('getTasksByAssignee filters correctly', () => {
      board.createTask({
        title: 'A',
        description: 'a',
        assigneeId: 'agent-1',
      });
      board.createTask({
        title: 'B',
        description: 'b',
        assigneeId: 'agent-2',
      });
      board.createTask({
        title: 'C',
        description: 'c',
        assigneeId: 'agent-1',
      });

      expect(board.getTasksByAssignee('agent-1')).toHaveLength(2);
      expect(board.getTasksByAssignee('agent-2')).toHaveLength(1);
    });

    it('getRootTasks returns only tasks without a parent', () => {
      const root = board.createTask({ title: 'Root', description: 'r' });
      board.createTask({
        title: 'Child',
        description: 'c',
        parentTaskId: root.id,
      });

      expect(board.getRootTasks()).toHaveLength(1);
      expect(board.getRootTasks()[0].title).toBe('Root');
    });
  });

  // ─── Dependency Management ─────────────────────────────────────────

  describe('dependencies', () => {
    it('adds a dependency', () => {
      const t1 = board.createTask({ title: 'First', description: 'f' });
      const t2 = board.createTask({ title: 'Second', description: 's' });

      const result = board.addDependency(t2.id, t1.id);
      expect(result).toBe(true);

      const updated = board.getTask(t2.id)!;
      expect(updated.dependsOn).toContain(t1.id);
    });

    it('prevents self-dependency', () => {
      const t1 = board.createTask({ title: 'Task', description: 'd' });
      expect(board.addDependency(t1.id, t1.id)).toBe(false);
    });

    it('prevents simple circular dependency (A->B->A)', () => {
      const t1 = board.createTask({ title: 'A', description: 'a' });
      const t2 = board.createTask({ title: 'B', description: 'b' });

      board.addDependency(t2.id, t1.id); // B depends on A
      const result = board.addDependency(t1.id, t2.id); // A depends on B -> cycle!

      expect(result).toBe(false);
    });

    it('prevents transitive circular dependency (A->B->C->A)', () => {
      const t1 = board.createTask({ title: 'A', description: 'a' });
      const t2 = board.createTask({ title: 'B', description: 'b' });
      const t3 = board.createTask({ title: 'C', description: 'c' });

      board.addDependency(t2.id, t1.id); // B depends on A
      board.addDependency(t3.id, t2.id); // C depends on B
      const result = board.addDependency(t1.id, t3.id); // A depends on C -> cycle!

      expect(result).toBe(false);
    });

    it('does not duplicate dependencies', () => {
      const t1 = board.createTask({ title: 'A', description: 'a' });
      const t2 = board.createTask({ title: 'B', description: 'b' });

      board.addDependency(t2.id, t1.id);
      board.addDependency(t2.id, t1.id); // duplicate

      expect(board.getTask(t2.id)!.dependsOn).toHaveLength(1);
    });

    it('returns false for non-existent task', () => {
      const t1 = board.createTask({ title: 'A', description: 'a' });
      expect(board.addDependency('fake-id', t1.id)).toBe(false);
    });
  });

  // ─── Ready Tasks ───────────────────────────────────────────────────

  describe('getReadyTasks', () => {
    it('returns pending tasks with all dependencies met', () => {
      const t1 = board.createTask({ title: 'A', description: 'a' });
      const t2 = board.createTask({ title: 'B', description: 'b' });
      board.addDependency(t2.id, t1.id);

      // t1 is ready (no deps), t2 is not (depends on t1)
      let ready = board.getReadyTasks();
      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe(t1.id);

      // Complete t1 -> t2 should become ready
      board.completeTask(t1.id);
      ready = board.getReadyTasks();
      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe(t2.id);
    });

    it('excludes non-pending tasks', () => {
      const t1 = board.createTask({ title: 'A', description: 'a' });
      board.assignTask(t1.id, 'agent-1');

      expect(board.getReadyTasks()).toHaveLength(0);
    });
  });

  // ─── Task Lifecycle ────────────────────────────────────────────────

  describe('lifecycle methods', () => {
    it('assignTask sets assignee and status', () => {
      const task = board.createTask({ title: 'T', description: 'd' });
      const assigned = board.assignTask(task.id, 'agent-1');

      expect(assigned?.assigneeId).toBe('agent-1');
      expect(assigned?.status).toBe(TaskStatus.Assigned);
    });

    it('startTask sets InProgress status', () => {
      const task = board.createTask({ title: 'T', description: 'd' });
      const started = board.startTask(task.id);

      expect(started?.status).toBe(TaskStatus.InProgress);
    });

    it('completeTask sets Completed status and completedAt', () => {
      const task = board.createTask({ title: 'T', description: 'd' });
      const completed = board.completeTask(task.id);

      expect(completed?.status).toBe(TaskStatus.Completed);
      expect(completed?.completedAt).toBeInstanceOf(Date);
    });

    it('failTask sets Failed status', () => {
      const task = board.createTask({ title: 'T', description: 'd' });
      const failed = board.failTask(task.id);

      expect(failed?.status).toBe(TaskStatus.Failed);
    });

    it('blockTask sets Blocked status and records blocker', () => {
      const t1 = board.createTask({ title: 'A', description: 'a' });
      const t2 = board.createTask({ title: 'B', description: 'b' });

      const blocked = board.blockTask(t2.id, t1.id);
      expect(blocked?.status).toBe(TaskStatus.Blocked);
      expect(blocked?.blockedBy).toContain(t1.id);
    });
  });

  // ─── completeTask with summary ─────────────────────────────────────

  describe('completeTask with summary', () => {
    it('stores completionSummary in task metadata', () => {
      const task = board.createTask({ title: 'T', description: 'd' });
      board.completeTask(task.id, 'Built REST API with 5 endpoints');

      const completed = board.getTask(task.id)!;
      expect(completed.status).toBe(TaskStatus.Completed);
      expect(completed.metadata['completionSummary']).toBe('Built REST API with 5 endpoints');
    });

    it('completeTask without summary still works (backwards compatible)', () => {
      const task = board.createTask({ title: 'T', description: 'd' });
      const completed = board.completeTask(task.id);

      expect(completed?.status).toBe(TaskStatus.Completed);
      expect(completed?.metadata['completionSummary']).toBeUndefined();
    });

    it('completing a task still unblocks dependents', () => {
      const t1 = board.createTask({ title: 'A', description: 'a' });
      const t2 = board.createTask({ title: 'B', description: 'b' });
      board.addDependency(t2.id, t1.id);

      const changeListener = vi.fn();
      board.onTaskChange(changeListener);

      board.completeTask(t1.id, 'Done with A');

      // t2 should now be ready (still Pending, deps met)
      expect(board.areDependenciesMet(t2.id)).toBe(true);
      // The fireChange for t2 should have been called
      const firedTasks = changeListener.mock.calls.map((c: any) => c[0]);
      const t2Fired = firedTasks.some((t: Task) => t.id === t2.id);
      expect(t2Fired).toBe(true);
    });
  });

  // ─── areDependenciesMet ────────────────────────────────────────────

  describe('areDependenciesMet', () => {
    it('returns true when all dependencies are completed', () => {
      const t1 = board.createTask({ title: 'A', description: 'a' });
      const t2 = board.createTask({ title: 'B', description: 'b' });
      board.addDependency(t2.id, t1.id);

      expect(board.areDependenciesMet(t2.id)).toBe(false);

      board.completeTask(t1.id);
      expect(board.areDependenciesMet(t2.id)).toBe(true);
    });

    it('returns true for tasks with no dependencies', () => {
      const t1 = board.createTask({ title: 'A', description: 'a' });
      expect(board.areDependenciesMet(t1.id)).toBe(true);
    });

    it('returns false for non-existent task', () => {
      expect(board.areDependenciesMet('fake-id')).toBe(false);
    });
  });

  // ─── Statistics ────────────────────────────────────────────────────

  describe('getStats', () => {
    it('returns correct counts for various states', () => {
      const t1 = board.createTask({ title: 'A', description: 'a' });
      const t2 = board.createTask({ title: 'B', description: 'b' });
      const t3 = board.createTask({ title: 'C', description: 'c' });
      const t4 = board.createTask({ title: 'D', description: 'd' });
      const t5 = board.createTask({ title: 'E', description: 'e' });

      board.completeTask(t1.id);
      board.failTask(t2.id);
      board.blockTask(t3.id);
      board.assignTask(t4.id, 'agent-1');
      // t5 stays pending

      const stats = board.getStats();
      expect(stats.total).toBe(5);
      expect(stats.completed).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.blocked).toBe(1);
      expect(stats.inProgress).toBe(1); // assigned counts as in-progress
      expect(stats.pending).toBe(1);
    });

    it('returns zeros when empty', () => {
      const stats = board.getStats();
      expect(stats.total).toBe(0);
      expect(stats.completed).toBe(0);
    });
  });

  // ─── Clear / Dispose ───────────────────────────────────────────────

  it('clear removes all tasks', () => {
    board.createTask({ title: 'A', description: 'a' });
    board.createTask({ title: 'B', description: 'b' });
    board.clear();

    expect(board.getAllTasks()).toHaveLength(0);
  });
});
