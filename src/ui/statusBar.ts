import * as vscode from 'vscode';
import { TaskBoard } from '../orchestration/taskBoard';
import { Scheduler } from '../orchestration/scheduler';
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
    private readonly agentRegistry: AgentRegistry,
    private readonly scheduler?: Scheduler
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
    const isPaused = this.scheduler?.getIsPaused() ?? false;

    // Main status
    if (isPaused) {
      this.statusItem.text = `$(debug-pause) DevCrew (Paused)`;
      this.statusItem.tooltip = `DevCrew: PAUSED — ${agents.length} agents\nUse "DevCrew: Resume Team" to continue`;
      this.statusItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground'
      );
    } else {
      this.statusItem.text = `$(organization) DevCrew`;
      this.statusItem.tooltip = `DevCrew: ${agents.length} agents\n${workingCount} working, ${blockedCount} blocked`;
      this.statusItem.backgroundColor = undefined;
    }

    // Progress
    if (stats.total > 0) {
      const effectiveTotal = stats.total - (stats.cancelled ?? 0);
      const pct = effectiveTotal > 0
        ? Math.round((stats.completed / effectiveTotal) * 100)
        : 0;
      this.progressItem.text = `$(tasklist) ${stats.completed}/${effectiveTotal} tasks (${pct}%)`;
      this.progressItem.tooltip = `DevCrew Progress: ${stats.completed} of ${effectiveTotal} tasks completed (${pct}%)`;

      if ((stats.cancelled ?? 0) > 0) {
        this.progressItem.text += ` (${stats.cancelled} cancelled)`;
      }

      if (isPaused && stats.paused > 0) {
        this.progressItem.text += ` $(debug-pause) ${stats.paused} paused`;
        this.progressItem.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground'
        );
      } else if (blockedCount > 0) {
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
