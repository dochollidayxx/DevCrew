import * as vscode from 'vscode';
import { TaskBoard } from '../orchestration/taskBoard';
import { AgentRegistry } from '../agents/registry';
import { MessageBus } from '../communication/messageBus';
import { TaskStatus, AgentStatus, Message, MessageType } from '../types';

/**
 * Webview panel that shows a rich dashboard with the task board,
 * agent status, dependency graph, and activity feed.
 */
export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly taskBoard: TaskBoard,
    private readonly agentRegistry: AgentRegistry,
    private readonly messageBus: MessageBus
  ) {
    this.panel = panel;

    // Update content when data changes
    this.disposables.push(
      taskBoard.onTaskChange(() => this.update()),
      taskBoard.onTaskAdded(() => this.update()),
      messageBus.onMessage(() => this.update())
    );

    // Handle panel disposal
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Handle messages from the webview
    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleWebviewMessage(msg),
      null,
      this.disposables
    );

    this.update();
  }

  static createOrShow(
    extensionUri: vscode.Uri,
    taskBoard: TaskBoard,
    agentRegistry: AgentRegistry,
    messageBus: MessageBus
  ): DashboardPanel {
    const column = vscode.ViewColumn.Beside;

    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.panel.reveal(column);
      return DashboardPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'devcrewDashboard',
      'DevCrew Dashboard',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    DashboardPanel.currentPanel = new DashboardPanel(
      panel,
      taskBoard,
      agentRegistry,
      messageBus
    );
    return DashboardPanel.currentPanel;
  }

  private update(): void {
    this.panel.webview.html = this.getHtml();
  }

  private handleWebviewMessage(msg: { command: string; data?: unknown }): void {
    switch (msg.command) {
      case 'refresh':
        this.update();
        break;
    }
  }

  private getHtml(): string {
    const stats = this.taskBoard.getStats();
    const agents = this.agentRegistry.getAllAgents();
    const tasks = this.taskBoard.getAllTasks();
    const recentMessages = this.messageBus.getHistory({ limit: 20 });

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DevCrew Dashboard</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --border: var(--vscode-panel-border);
      --card-bg: var(--vscode-editorWidget-background);
      --accent: var(--vscode-button-background);
      --success: var(--vscode-testing-iconPassed);
      --error: var(--vscode-testing-iconFailed);
      --warning: var(--vscode-editorWarning-foreground);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--fg);
      background: var(--bg);
      padding: 16px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px;
    }
    .card h2 {
      font-size: 14px;
      margin-bottom: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.8;
    }
    .stats {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    .stat {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px 16px;
      text-align: center;
      min-width: 80px;
    }
    .stat .number {
      font-size: 24px;
      font-weight: bold;
    }
    .stat .label {
      font-size: 11px;
      opacity: 0.7;
    }
    .agent-row, .task-row, .activity-row {
      display: flex;
      align-items: center;
      padding: 6px 0;
      border-bottom: 1px solid var(--border);
      gap: 8px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .status-idle { background: gray; }
    .status-working { background: var(--success); }
    .status-blocked { background: var(--error); }
    .status-done { background: var(--success); }
    .status-error { background: var(--error); }
    .status-waiting { background: var(--warning); }
    .badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--accent);
      color: var(--vscode-button-foreground);
    }
    .full-width { grid-column: 1 / -1; }
    .activity-time {
      font-size: 11px;
      opacity: 0.6;
      min-width: 70px;
    }
  </style>
</head>
<body>
  <div class="stats">
    <div class="stat">
      <div class="number">${stats.total}</div>
      <div class="label">Total</div>
    </div>
    <div class="stat">
      <div class="number" style="color: var(--success)">${stats.completed}</div>
      <div class="label">Done</div>
    </div>
    <div class="stat">
      <div class="number">${stats.inProgress}</div>
      <div class="label">Active</div>
    </div>
    <div class="stat">
      <div class="number" style="color: var(--warning)">${stats.pending}</div>
      <div class="label">Pending</div>
    </div>
    <div class="stat">
      <div class="number" style="color: var(--error)">${stats.blocked}</div>
      <div class="label">Blocked</div>
    </div>
    <div class="stat">
      <div class="number" style="color: var(--error)">${stats.failed}</div>
      <div class="label">Failed</div>
    </div>
    ${stats.cancelled > 0 ? `<div class="stat">
      <div class="number" style="opacity: 0.6">${stats.cancelled}</div>
      <div class="label">Cancelled</div>
    </div>` : ''}
  </div>

  <div class="grid">
    <div class="card">
      <h2>Team (${agents.length} agents)</h2>
      ${agents
        .map((a) => {
          const s = a.getState();
          return `<div class="agent-row">
            <span class="status-dot status-${this.statusClass(s.status)}"></span>
            <strong>${a.roleConfig.name}</strong>
            <span class="badge">${s.status}</span>
            ${s.currentTaskId ? `<span style="opacity:0.6">→ ${s.currentTaskId.slice(0, 12)}</span>` : ''}
          </div>`;
        })
        .join('')}
    </div>

    <div class="card">
      <h2>Task Board</h2>
      ${tasks.length === 0 ? '<p style="opacity:0.6">No tasks yet</p>' : ''}
      ${tasks
        .sort((a, b) => a.priority - b.priority)
        .map(
          (t) => `<div class="task-row">
            <span class="status-dot status-${this.taskStatusClass(t.status)}"></span>
            <span>${t.title}</span>
            <span class="badge">${t.status}</span>
            ${t.assigneeId ? `<span style="opacity:0.6">${this.escHtml(this.extractRoleName(t.assigneeId))}</span>` : ''}
          </div>`
        )
        .join('')}
    </div>

    <div class="card full-width">
      <h2>Recent Activity</h2>
      ${recentMessages.length === 0 ? '<p style="opacity:0.6">No activity yet</p>' : ''}
      ${recentMessages
        .reverse()
        .slice(0, 15)
        .map(
          (m) => `<div class="activity-row">
            <span class="activity-time">${m.timestamp.toLocaleTimeString()}</span>
            <span>${this.formatMessage(m)}</span>
          </div>`
        )
        .join('')}
    </div>
  </div>
</body>
</html>`;
  }

  private statusClass(status: AgentStatus): string {
    switch (status) {
      case AgentStatus.Idle:
        return 'idle';
      case AgentStatus.Working:
        return 'working';
      case AgentStatus.Blocked:
        return 'blocked';
      case AgentStatus.Error:
        return 'error';
      case AgentStatus.Done:
        return 'done';
      case AgentStatus.Paused:
        return 'waiting';
      case AgentStatus.WaitingForReview:
      case AgentStatus.WaitingForDependency:
        return 'waiting';
      default:
        return 'waiting';
    }
  }

  private taskStatusClass(status: TaskStatus): string {
    switch (status) {
      case TaskStatus.Completed:
        return 'done';
      case TaskStatus.InProgress:
      case TaskStatus.Assigned:
        return 'working';
      case TaskStatus.Blocked:
      case TaskStatus.Failed:
        return 'blocked';
      case TaskStatus.Cancelled:
      case TaskStatus.Paused:
        return 'waiting';
      case TaskStatus.InReview:
        return 'waiting';
      default:
        return 'idle';
    }
  }

  private escHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private extractRoleName(agentId: string): string {
    const match = agentId.match(/^agent-(.+)-\d+$/);
    return match ? match[1] : agentId;
  }

  private formatMessage(msg: Message): string {
    const from = this.escHtml(this.extractRoleName(msg.fromAgentId));

    switch (msg.type) {
      case MessageType.StatusUpdate:
        return `<strong>${from}</strong>: ${this.escHtml((msg.payload as { message: string }).message)}`;
      case MessageType.TaskCompleted:
        return `<strong>${from}</strong> completed a task`;
      case MessageType.TaskFailed:
        return `<strong>${from}</strong> task failed`;
      case MessageType.BlockerRaised:
        return `<strong>${from}</strong> is blocked`;
      case MessageType.Question:
        return `<strong>${from}</strong> asked a question`;
      default:
        return `${from}: ${this.escHtml(msg.type)}`;
    }
  }

  dispose(): void {
    DashboardPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
