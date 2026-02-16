import * as vscode from 'vscode';
import { TaskBoard } from '../orchestration/taskBoard';
import { Task, TaskStatus, TaskPriority } from '../types';

/**
 * TreeDataProvider for the "Task Board" sidebar panel. Shows tasks
 * grouped by status with dependency information.
 */
export class TaskTreeView
  implements vscode.TreeDataProvider<TaskTreeItem>
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<TaskTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly taskBoard: TaskBoard) {
    // Auto-refresh when tasks change
    taskBoard.onTaskChange(() => this.refresh());
    taskBoard.onTaskAdded(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TaskTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TaskTreeItem): TaskTreeItem[] {
    if (!element) {
      // Root level: group by status
      return this.getStatusGroups();
    }

    if (element.contextValue === 'status-group') {
      // Show tasks in this status group
      return this.getTasksForStatus(element.statusFilter!);
    }

    if (element.contextValue === 'task') {
      // Show task details
      return this.getTaskDetails(element.taskId!);
    }

    return [];
  }

  private getStatusGroups(): TaskTreeItem[] {
    const groups: { status: TaskStatus; label: string; icon: string }[] = [
      { status: TaskStatus.InProgress, label: 'In Progress', icon: 'sync~spin' },
      { status: TaskStatus.Assigned, label: 'Assigned', icon: 'person' },
      { status: TaskStatus.Pending, label: 'Pending', icon: 'circle-outline' },
      { status: TaskStatus.Blocked, label: 'Blocked', icon: 'error' },
      { status: TaskStatus.InReview, label: 'In Review', icon: 'eye' },
      { status: TaskStatus.Completed, label: 'Completed', icon: 'pass-filled' },
      { status: TaskStatus.Failed, label: 'Failed', icon: 'circle-slash' },
    ];

    return groups
      .map((g) => {
        const tasks = this.taskBoard.getTasksByStatus(g.status);
        if (tasks.length === 0) return null;

        const item = new TaskTreeItem(
          `${g.label} (${tasks.length})`,
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.iconPath = new vscode.ThemeIcon(g.icon);
        item.contextValue = 'status-group';
        item.statusFilter = g.status;
        return item;
      })
      .filter((item): item is TaskTreeItem => item !== null);
  }

  private getTasksForStatus(status: TaskStatus): TaskTreeItem[] {
    const tasks = this.taskBoard.getTasksByStatus(status);
    return tasks
      .sort((a, b) => a.priority - b.priority)
      .map((task) => {
        const item = new TaskTreeItem(
          `${this.priorityIcon(task.priority)} ${task.title}`,
          vscode.TreeItemCollapsibleState.Collapsed
        );
        item.taskId = task.id;
        item.contextValue = 'task';
        item.description = task.assigneeId
          ? `→ ${task.assigneeId.split('-')[1]}`
          : 'unassigned';
        item.tooltip = new vscode.MarkdownString(
          `**${task.title}**\n\n${task.description}\n\n` +
            `Priority: ${TaskPriority[task.priority]}\n` +
            `Status: ${task.status}`
        );
        return item;
      });
  }

  private getTaskDetails(taskId: string): TaskTreeItem[] {
    const task = this.taskBoard.getTask(taskId);
    if (!task) return [];

    const items: TaskTreeItem[] = [];

    // Description
    items.push(
      new TaskTreeItem(task.description, vscode.TreeItemCollapsibleState.None)
    );

    // Dependencies
    if (task.dependsOn.length > 0) {
      for (const depId of task.dependsOn) {
        const dep = this.taskBoard.getTask(depId);
        const depItem = new TaskTreeItem(
          `Depends on: ${dep?.title ?? depId}`,
          vscode.TreeItemCollapsibleState.None
        );
        depItem.iconPath = new vscode.ThemeIcon('arrow-right');
        items.push(depItem);
      }
    }

    // Files
    if (task.files.length > 0) {
      for (const file of task.files) {
        const fileItem = new TaskTreeItem(
          `${file.type}: ${file.filePath}`,
          vscode.TreeItemCollapsibleState.None
        );
        fileItem.iconPath = new vscode.ThemeIcon('file');
        items.push(fileItem);
      }
    }

    return items;
  }

  private priorityIcon(priority: TaskPriority): string {
    switch (priority) {
      case TaskPriority.Critical:
        return '🔴';
      case TaskPriority.High:
        return '🟠';
      case TaskPriority.Medium:
        return '🟡';
      case TaskPriority.Low:
        return '🟢';
    }
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

class TaskTreeItem extends vscode.TreeItem {
  taskId?: string;
  statusFilter?: TaskStatus;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
  }
}
