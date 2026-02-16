import * as vscode from 'vscode';
import { MessageBus } from '../communication/messageBus';
import { Message, MessageType } from '../types';

/**
 * TreeDataProvider for the "Activity Feed" sidebar panel. Shows
 * a real-time stream of messages between agents.
 */
export class ActivityTreeView
  implements vscode.TreeDataProvider<ActivityItem>
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<ActivityItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private activities: ActivityEntry[] = [];
  private readonly maxActivities = 100;

  constructor(private readonly messageBus: MessageBus) {
    messageBus.onMessage((msg) => this.addActivity(msg));
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ActivityItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ActivityItem[] {
    // Show most recent first
    return [...this.activities]
      .reverse()
      .map((entry) => {
        const item = new ActivityItem(
          entry.label,
          vscode.TreeItemCollapsibleState.None
        );
        item.description = entry.timestamp;
        item.iconPath = new vscode.ThemeIcon(entry.icon);
        item.tooltip = entry.detail;
        return item;
      });
  }

  private addActivity(message: Message): void {
    const entry = this.messageToActivity(message);
    if (!entry) return;

    this.activities.push(entry);
    if (this.activities.length > this.maxActivities) {
      this.activities.shift();
    }

    this.refresh();
  }

  private messageToActivity(msg: Message): ActivityEntry | null {
    const time = msg.timestamp.toLocaleTimeString();
    const from = msg.fromAgentId.split('-')[1] ?? msg.fromAgentId;

    switch (msg.type) {
      case MessageType.StatusUpdate: {
        const payload = msg.payload as { message: string };
        return {
          label: `${from}: ${payload.message}`,
          timestamp: time,
          icon: 'info',
          detail: payload.message,
        };
      }
      case MessageType.TaskCompleted: {
        const payload = msg.payload as { taskId: string };
        return {
          label: `${from} completed task`,
          timestamp: time,
          icon: 'pass-filled',
          detail: `Task ${payload.taskId} completed`,
        };
      }
      case MessageType.TaskFailed: {
        const payload = msg.payload as { taskId: string; error: string };
        return {
          label: `${from} task failed`,
          timestamp: time,
          icon: 'error',
          detail: payload.error,
        };
      }
      case MessageType.BlockerRaised: {
        const payload = msg.payload as { description: string };
        return {
          label: `${from} BLOCKED: ${payload.description.slice(0, 60)}`,
          timestamp: time,
          icon: 'warning',
          detail: payload.description,
        };
      }
      case MessageType.Question: {
        const payload = msg.payload as { question: string };
        return {
          label: `${from} asks: ${payload.question.slice(0, 60)}`,
          timestamp: time,
          icon: 'comment-discussion',
          detail: payload.question,
        };
      }
      case MessageType.FileWriteRequest: {
        return {
          label: `${from} writing file`,
          timestamp: time,
          icon: 'file-add',
          detail: JSON.stringify(msg.payload),
        };
      }
      case MessageType.TaskDecomposition: {
        const payload = msg.payload as { taskCount: number };
        return {
          label: `Team Lead created ${payload.taskCount} tasks`,
          timestamp: time,
          icon: 'list-tree',
          detail: `Decomposed into ${payload.taskCount} tasks`,
        };
      }
      case MessageType.IntegrationStart: {
        return {
          label: `Integration phase started`,
          timestamp: time,
          icon: 'git-merge',
          detail: 'Team Lead is integrating completed work',
        };
      }
      case MessageType.IntegrationComplete: {
        return {
          label: `Integration complete`,
          timestamp: time,
          icon: 'check-all',
          detail: 'All work integrated successfully',
        };
      }
      default:
        return null;
    }
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

interface ActivityEntry {
  label: string;
  timestamp: string;
  icon: string;
  detail: string;
}

class ActivityItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
  }
}
