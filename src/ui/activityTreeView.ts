import * as vscode from 'vscode';
import { MessageBus } from '../communication/messageBus';
import { Message, MessageType } from '../types';

/**
 * TreeDataProvider for the "Activity Feed" sidebar panel.
 *
 * Task-related events (file writes, status updates, blockers) nest under
 * a collapsible task-group parent created when a task starts (iteration 1).
 * Non-task events (AgentCreated, TaskDecomposition, etc.) stay top-level.
 *
 * Both top-level items and children within a group are sorted newest-first
 * so the latest activity is always visible without scrolling.
 */
export class ActivityTreeView
  implements vscode.TreeDataProvider<ActivityItem>
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<ActivityItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Top-level entries in insertion order (reversed for display). */
  private topLevel: TopLevelEntry[] = [];
  /** Task groups keyed by taskId. */
  private taskGroups: Map<string, TaskGroup> = new Map();
  private readonly maxTopLevel = 100;

  constructor(private readonly messageBus: MessageBus) {
    messageBus.onMessage((msg) => this.handleMessage(msg));
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ActivityItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ActivityItem): ActivityItem[] {
    if (!element) {
      // Top-level: newest first
      return [...this.topLevel]
        .reverse()
        .map((e) => this.topLevelToItem(e));
    }

    // Children of a task group: newest first
    if (element.groupTaskId) {
      const group = this.taskGroups.get(element.groupTaskId);
      if (!group || group.children.length === 0) return [];
      return [...group.children]
        .reverse()
        .map((child) => this.entryToItem(child));
    }

    return [];
  }

  // ─── Message Router ───────────────────────────────────────────────

  private handleMessage(msg: Message): void {
    const time = msg.timestamp.toLocaleTimeString();
    const name = this.agentName(msg);
    const payload = msg.payload as Record<string, unknown> | undefined;
    const taskId = (payload?.taskId as string) ?? null;

    switch (msg.type) {
      // ── Task lifecycle: creates / mutates groups ──────────────────

      case MessageType.IterationProgress: {
        const p = payload as {
          iteration: number;
          taskId: string;
          taskTitle?: string;
        };
        // Only iteration 1 creates the group; skip the rest
        if (p.iteration !== 1) return;

        const title = p.taskTitle ?? `Task ${p.taskId}`;
        const group: TaskGroup = {
          taskId: p.taskId,
          parentEntry: {
            label: `${name}: ${this.truncate(title, 60)}`,
            timestamp: time,
            icon: 'sync~spin',
            iconColor: 'charts.blue',
            detail: `Working on: ${title}`,
          },
          children: [],
          status: 'active',
        };
        this.taskGroups.set(p.taskId, group);
        this.pushTopLevel({ type: 'task-group', taskId: p.taskId });
        break;
      }

      case MessageType.TaskCompleted: {
        const p = payload as { taskId: string; taskTitle?: string; summary?: string };
        const title = p.taskTitle ?? `Task ${p.taskId}`;
        const group = this.taskGroups.get(p.taskId);
        if (group) {
          group.parentEntry.icon = 'pass-filled';
          group.parentEntry.iconColor = 'testing.iconPassed';
          group.parentEntry.label = `${name} completed: ${title}`;
          group.status = 'completed';
          this.refresh();
        } else {
          this.pushTopLevel({
            type: 'standalone',
            entry: {
              label: `${name} completed: ${title}`,
              timestamp: time,
              icon: 'pass-filled',
              iconColor: 'testing.iconPassed',
              detail: p.summary?.slice(0, 200) ?? `${title} completed`,
            },
          });
        }
        break;
      }

      case MessageType.TaskFailed: {
        const p = payload as { taskId: string; taskTitle?: string; error: string };
        const title = p.taskTitle ?? `Task ${p.taskId}`;
        const group = this.taskGroups.get(p.taskId);
        if (group) {
          group.parentEntry.icon = 'error';
          group.parentEntry.iconColor = 'testing.iconFailed';
          group.parentEntry.label = `${name} failed: ${title}`;
          group.status = 'failed';
          this.refresh();
        } else {
          this.pushTopLevel({
            type: 'standalone',
            entry: {
              label: `${name} failed: ${title}`,
              timestamp: time,
              icon: 'error',
              iconColor: 'testing.iconFailed',
              detail: p.error,
            },
          });
        }
        break;
      }

      // ── Nest under task group when taskId matches ─────────────────

      case MessageType.FileWritten: {
        const p = payload as { filePath: string };
        this.addChildOrTopLevel(taskId, {
          label: `${name} wrote ${p.filePath}`,
          timestamp: time,
          icon: 'file-code',
          iconColor: 'charts.green',
          detail: p.filePath,
        });
        break;
      }

      case MessageType.FileEdited: {
        const p = payload as { filePath: string };
        this.addChildOrTopLevel(taskId, {
          label: `${name} edited ${p.filePath}`,
          timestamp: time,
          icon: 'edit',
          iconColor: 'charts.purple',
          detail: p.filePath,
        });
        break;
      }

      case MessageType.CommandExecuted: {
        const p = payload as { command: string; success: boolean };
        this.addChildOrTopLevel(taskId, {
          label: `${name} ran ${p.command}`,
          timestamp: time,
          icon: 'terminal',
          iconColor: p.success ? 'charts.blue' : 'testing.iconFailed',
          detail: p.command,
        });
        break;
      }

      case MessageType.FileRead: {
        const p = payload as { filePath: string };
        this.addChildOrTopLevel(taskId, {
          label: `${name} read ${p.filePath}`,
          timestamp: time,
          icon: 'go-to-file',
          iconColor: 'charts.gray',
          detail: p.filePath,
        });
        break;
      }

      case MessageType.FilesListed: {
        const p = payload as { dirPath: string; pattern: string };
        this.addChildOrTopLevel(taskId, {
          label: `${name} listed ${p.dirPath}/${p.pattern}`,
          timestamp: time,
          icon: 'folder-opened',
          iconColor: 'charts.gray',
          detail: `${p.dirPath}/${p.pattern}`,
        });
        break;
      }

      case MessageType.StatusUpdate: {
        const p = payload as { message: string };
        this.addChildOrTopLevel(taskId, {
          label: `${name}: ${this.truncate(p.message, 80)}`,
          timestamp: time,
          icon: 'info',
          iconColor: 'charts.gray',
          detail: p.message,
        });
        break;
      }

      case MessageType.BlockerRaised: {
        const p = payload as { description: string };
        this.addChildOrTopLevel(taskId, {
          label: `${name} BLOCKED: ${this.truncate(p.description, 60)}`,
          timestamp: time,
          icon: 'warning',
          iconColor: 'editorWarning.foreground',
          detail: p.description,
        });
        break;
      }

      case MessageType.BlockerResolved: {
        const p = payload as { taskId: string };
        this.addChildOrTopLevel(taskId, {
          label: `${name} blocker resolved`,
          timestamp: time,
          icon: 'pass',
          iconColor: 'testing.iconPassed',
          detail: `Blocker on task ${p.taskId} resolved`,
        });
        break;
      }

      // ── Always top-level ──────────────────────────────────────────

      case MessageType.Question: {
        const p = payload as { question: string };
        this.pushTopLevel({
          type: 'standalone',
          entry: {
            label: `${name} asks: ${this.truncate(p.question, 60)}`,
            timestamp: time,
            icon: 'comment-discussion',
            iconColor: 'charts.blue',
            detail: p.question,
          },
        });
        break;
      }

      case MessageType.Answer: {
        const p = payload as { answer: string };
        this.pushTopLevel({
          type: 'standalone',
          entry: {
            label: `${name} answered: ${this.truncate(p.answer ?? '', 60)}`,
            timestamp: time,
            icon: 'comment',
            iconColor: 'charts.blue',
            detail: p.answer ?? '',
          },
        });
        break;
      }

      case MessageType.TaskDecomposition: {
        const p = payload as { taskCount: number };
        this.pushTopLevel({
          type: 'standalone',
          entry: {
            label: `Team Lead created ${p.taskCount} tasks`,
            timestamp: time,
            icon: 'list-tree',
            iconColor: 'charts.blue',
            detail: `Decomposed into ${p.taskCount} tasks`,
          },
        });
        break;
      }

      case MessageType.IntegrationStart:
        this.pushTopLevel({
          type: 'standalone',
          entry: {
            label: 'Integration phase started',
            timestamp: time,
            icon: 'git-merge',
            iconColor: 'charts.blue',
            detail: 'Team Lead is integrating completed work',
          },
        });
        break;

      case MessageType.IntegrationComplete:
        this.pushTopLevel({
          type: 'standalone',
          entry: {
            label: 'Integration complete',
            timestamp: time,
            icon: 'check-all',
            iconColor: 'testing.iconPassed',
            detail: 'All work integrated successfully',
          },
        });
        break;

      case MessageType.AgentCreated: {
        const p = payload as { name: string; role: string };
        this.pushTopLevel({
          type: 'standalone',
          entry: {
            label: `Agent created: ${p.name} (${p.role})`,
            timestamp: time,
            icon: 'person-add',
            iconColor: 'charts.green',
            detail: `New team member: ${p.name}`,
          },
        });
        break;
      }

      case MessageType.AgentRemoved: {
        const p = payload as { name: string; role: string };
        this.pushTopLevel({
          type: 'standalone',
          entry: {
            label: `Agent removed: ${p.name} (${p.role})`,
            timestamp: time,
            icon: 'person',
            iconColor: 'charts.gray',
            detail: `Team member removed: ${p.name}`,
          },
        });
        break;
      }

      case MessageType.ReviewRequest:
        this.pushTopLevel({
          type: 'standalone',
          entry: {
            label: `${name} requested review`,
            timestamp: time,
            icon: 'eye',
            iconColor: 'charts.blue',
            detail: JSON.stringify(msg.payload),
          },
        });
        break;

      case MessageType.ReviewResult:
        this.pushTopLevel({
          type: 'standalone',
          entry: {
            label: `${name} completed review`,
            timestamp: time,
            icon: 'checklist',
            iconColor: 'testing.iconPassed',
            detail: JSON.stringify(msg.payload),
          },
        });
        break;

      case MessageType.TeamDirective: {
        const p = payload as { directive: string };
        this.pushTopLevel({
          type: 'standalone',
          entry: {
            label: `Team Lead directive: ${this.truncate(p.directive, 60)}`,
            timestamp: time,
            icon: 'megaphone',
            iconColor: 'charts.blue',
            detail: p.directive,
          },
        });
        break;
      }

      // Skip noisy internal messages
      case MessageType.StreamingChunk:
      case MessageType.FileWriteRequest:
        break;

      default:
        break;
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  /**
   * If a task group exists for the given taskId, add the entry as a
   * child of that group. Otherwise add it as a top-level standalone.
   */
  private addChildOrTopLevel(taskId: string | null, entry: ActivityEntry): void {
    if (taskId && this.taskGroups.has(taskId)) {
      this.taskGroups.get(taskId)!.children.push(entry);
      this.refresh();
    } else {
      this.pushTopLevel({ type: 'standalone', entry });
    }
  }

  private pushTopLevel(entry: TopLevelEntry): void {
    this.topLevel.push(entry);
    if (this.topLevel.length > this.maxTopLevel) {
      const evicted = this.topLevel.shift()!;
      if (evicted.type === 'task-group' && evicted.taskId) {
        this.taskGroups.delete(evicted.taskId);
      }
    }
    this.refresh();
  }

  private topLevelToItem(entry: TopLevelEntry): ActivityItem {
    if (entry.type === 'task-group' && entry.taskId) {
      const group = this.taskGroups.get(entry.taskId);
      if (group) {
        const childCount = group.children.length;
        const collapsible = childCount > 0
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None;
        const item = this.entryToItem(group.parentEntry, collapsible);
        item.groupTaskId = entry.taskId;
        // Show child count + original timestamp in description
        if (childCount > 0) {
          item.description = `(${childCount}) ${group.parentEntry.timestamp}`;
        }
        return item;
      }
    }

    return this.entryToItem(entry.entry!);
  }

  private entryToItem(
    entry: ActivityEntry,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
  ): ActivityItem {
    const item = new ActivityItem(entry.label, collapsibleState);
    item.description = entry.timestamp;
    item.iconPath = new vscode.ThemeIcon(
      entry.icon,
      entry.iconColor ? new vscode.ThemeColor(entry.iconColor) : undefined
    );
    item.tooltip = entry.detail;
    return item;
  }

  /**
   * Derive a consistent display name from a message.
   *
   * Priority:
   * 1. payload.agentName (set by IterationProgress, FileWritten, etc.)
   * 2. Strip `agent-` prefix and trailing timestamp from fromAgentId,
   *    then title-case the role portion.
   */
  private agentName(msg: Message): string {
    const payload = msg.payload as Record<string, unknown> | undefined;
    if (payload?.agentName && typeof payload.agentName === 'string') {
      return payload.agentName;
    }

    const id = msg.fromAgentId;
    const match = id.match(/^agent-(.+)-\d+$/);
    if (match) {
      return match[1]
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    }

    const stripped = id.replace(/^agent-/, '');
    return stripped.charAt(0).toUpperCase() + stripped.slice(1);
  }

  private truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.slice(0, max - 1) + '\u2026';
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface ActivityEntry {
  label: string;
  timestamp: string;
  icon: string;
  iconColor?: string;
  detail: string;
}

interface TopLevelEntry {
  type: 'standalone' | 'task-group';
  entry?: ActivityEntry;   // for standalone
  taskId?: string;         // for task-group (references taskGroups map)
}

interface TaskGroup {
  taskId: string;
  parentEntry: ActivityEntry;
  children: ActivityEntry[];
  status: 'active' | 'completed' | 'failed';
}

class ActivityItem extends vscode.TreeItem {
  /** Set on task-group parent items so getChildren can look up the group. */
  groupTaskId?: string;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
  }
}
