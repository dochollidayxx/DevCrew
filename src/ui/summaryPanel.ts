import * as vscode from 'vscode';
import { TaskBoard } from '../orchestration/taskBoard';
import { AgentRegistry } from '../agents/registry';
import { TaskStatus, TASK_METADATA } from '../types';

/**
 * Summary data passed from TeamLeadAgent.reportFinalStatus() to the panel.
 */
export interface SummaryData {
  completed: number;
  failed: number;
  total: number;
  tasks: Array<{
    title: string;
    status: 'completed' | 'failed';
    assigneeName: string;
    summary?: string;
    filesWritten?: string[];
    error?: string;
  }>;
}

/**
 * Webview panel that shows a persistent final summary when all work
 * is done — replaces the ephemeral `showInformationMessage` popup.
 */
export class SummaryPanel {
  public static currentPanel: SummaryPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly data: SummaryData
  ) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.update();
  }

  static createOrShow(
    taskBoard: TaskBoard,
    agentRegistry: AgentRegistry
  ): SummaryPanel {
    const column = vscode.ViewColumn.One;

    if (SummaryPanel.currentPanel) {
      SummaryPanel.currentPanel.panel.reveal(column);
      return SummaryPanel.currentPanel;
    }

    const data = SummaryPanel.buildSummaryData(taskBoard, agentRegistry);

    const panel = vscode.window.createWebviewPanel(
      'devcrewSummary',
      'DevCrew — Complete',
      column,
      { enableScripts: false }
    );

    SummaryPanel.currentPanel = new SummaryPanel(panel, data);
    return SummaryPanel.currentPanel;
  }

  private static buildSummaryData(
    taskBoard: TaskBoard,
    agentRegistry: AgentRegistry
  ): SummaryData {
    const stats = taskBoard.getStats();
    const allTasks = taskBoard.getAllTasks();
    const effectiveTotal = stats.total - (stats.cancelled ?? 0);

    const tasks: SummaryData['tasks'] = allTasks
      .filter((t) => t.status === TaskStatus.Completed || t.status === TaskStatus.Failed)
      .map((t) => {
        const agent = t.assigneeId
          ? agentRegistry.getAllAgents().find((a) => a.id === t.assigneeId)
          : undefined;
        const assigneeName = agent?.roleConfig.name ?? 'Unassigned';

        if (t.status === TaskStatus.Failed) {
          return {
            title: t.title,
            status: 'failed' as const,
            assigneeName,
            error: (t.metadata[TASK_METADATA.failureReason] as string) ?? 'Unknown error',
          };
        }

        return {
          title: t.title,
          status: 'completed' as const,
          assigneeName,
          summary: (t.metadata[TASK_METADATA.completionSummary] as string)?.slice(0, 300),
          filesWritten: (t.metadata[TASK_METADATA.filesWritten] as string[]) ?? [],
        };
      });

    return {
      completed: stats.completed,
      failed: stats.failed,
      total: effectiveTotal,
      tasks,
    };
  }

  private update(): void {
    this.panel.webview.html = this.getHtml();
  }

  private esc(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private getHtml(): string {
    const { completed, failed, total, tasks } = this.data;
    const completedTasks = tasks.filter((t) => t.status === 'completed');
    const failedTasks = tasks.filter((t) => t.status === 'failed');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DevCrew Summary</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --border: var(--vscode-panel-border);
      --card-bg: var(--vscode-editorWidget-background);
      --success: var(--vscode-testing-iconPassed);
      --error: var(--vscode-testing-iconFailed);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--fg);
      background: var(--bg);
      padding: 24px;
      max-width: 800px;
      margin: 0 auto;
    }
    h1 {
      font-size: 20px;
      margin-bottom: 4px;
    }
    .subtitle {
      font-size: 13px;
      opacity: 0.7;
      margin-bottom: 24px;
    }
    .stats {
      display: flex;
      gap: 12px;
      margin-bottom: 24px;
    }
    .stat {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px 16px;
      text-align: center;
      min-width: 80px;
    }
    .stat .number { font-size: 24px; font-weight: bold; }
    .stat .label { font-size: 11px; opacity: 0.7; }
    h2 {
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.8;
      margin: 20px 0 10px;
    }
    .task-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px 16px;
      margin-bottom: 8px;
    }
    .task-title {
      font-weight: bold;
      margin-bottom: 4px;
    }
    .task-meta {
      font-size: 12px;
      opacity: 0.7;
      margin-bottom: 6px;
    }
    .task-summary {
      font-size: 13px;
      line-height: 1.4;
    }
    .files {
      margin-top: 6px;
      font-size: 12px;
      opacity: 0.8;
    }
    .files code {
      font-family: var(--vscode-editor-font-family);
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
    }
    .error-reason {
      color: var(--error);
      font-size: 13px;
    }
    .badge-ok { color: var(--success); }
    .badge-fail { color: var(--error); }
  </style>
</head>
<body>
  <h1>DevCrew &mdash; Complete</h1>
  <p class="subtitle">${total} task${total !== 1 ? 's' : ''} processed</p>

  <div class="stats">
    <div class="stat">
      <div class="number">${total}</div>
      <div class="label">Total</div>
    </div>
    <div class="stat">
      <div class="number badge-ok">${completed}</div>
      <div class="label">Completed</div>
    </div>
    ${failed > 0 ? `<div class="stat">
      <div class="number badge-fail">${failed}</div>
      <div class="label">Failed</div>
    </div>` : ''}
  </div>

  ${completedTasks.length > 0 ? `<h2>Completed Tasks</h2>` : ''}
  ${completedTasks
    .map(
      (t) => `<div class="task-card">
      <div class="task-title">${this.esc(t.title)}</div>
      <div class="task-meta">Assignee: ${this.esc(t.assigneeName)}</div>
      ${t.summary ? `<div class="task-summary">${this.esc(t.summary)}</div>` : ''}
      ${t.filesWritten && t.filesWritten.length > 0
        ? `<div class="files">Files: ${t.filesWritten.map((f) => `<code>${this.esc(f)}</code>`).join(' ')}</div>`
        : ''}
    </div>`
    )
    .join('')}

  ${failedTasks.length > 0 ? `<h2>Failed Tasks</h2>` : ''}
  ${failedTasks
    .map(
      (t) => `<div class="task-card">
      <div class="task-title">${this.esc(t.title)}</div>
      <div class="task-meta">Assignee: ${this.esc(t.assigneeName)}</div>
      <div class="error-reason">${this.esc(t.error ?? 'Unknown error')}</div>
    </div>`
    )
    .join('')}
</body>
</html>`;
  }

  dispose(): void {
    SummaryPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
