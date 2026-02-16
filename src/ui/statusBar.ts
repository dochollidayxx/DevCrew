import * as vscode from 'vscode';
import { TaskBoard } from '../orchestration/taskBoard';
import { AgentRegistry } from '../agents/registry';
import { AgentStatus } from '../types';

/**
 * Status bar integration showing team progress at a glance.
 */
export class DevCrewStatusBar {
  private statusItem: vscode.StatusBarItem;
  private progressItem: vscode.StatusBarItem;
  private updateInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly taskBoard: TaskBoard,
    private readonly agentRegistry: AgentRegistry
  ) {
    this.statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusItem.command = 'devcrew.showDashboard';

    this.progressItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      99
    );
  }

  show(): void {
    this.statusItem.show();
    this.progressItem.show();
    this.update();

    this.updateInterval = setInterval(() => this.update(), 3000);
  }

  hide(): void {
    this.statusItem.hide();
    this.progressItem.hide();
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  private update(): void {
    const stats = this.taskBoard.getStats();
    const agents = this.agentRegistry.getAllAgents();
    const workingCount = agents.filter(
      (a) => a.getState().status === AgentStatus.Working
    ).length;
    const blockedCount = agents.filter(
      (a) => a.getState().status === AgentStatus.Blocked
    ).length;

    // Main status
    this.statusItem.text = `$(organization) DevCrew`;
    this.statusItem.tooltip = `DevCrew: ${agents.length} agents\n${workingCount} working, ${blockedCount} blocked`;

    // Progress
    if (stats.total > 0) {
      const pct = Math.round((stats.completed / stats.total) * 100);
      this.progressItem.text = `${stats.completed}/${stats.total} tasks (${pct}%)`;

      if (blockedCount > 0) {
        this.progressItem.text += ` $(warning) ${blockedCount} blocked`;
        this.progressItem.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground'
        );
      } else {
        this.progressItem.backgroundColor = undefined;
      }
    } else {
      this.progressItem.text = 'No tasks';
    }
  }

  dispose(): void {
    this.hide();
    this.statusItem.dispose();
    this.progressItem.dispose();
  }
}
