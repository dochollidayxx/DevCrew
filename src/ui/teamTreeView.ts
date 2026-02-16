import * as vscode from 'vscode';
import { Agent } from '../agents/agent';
import { AgentRegistry } from '../agents/registry';
import { AgentStatus } from '../types';

/**
 * TreeDataProvider for the "Team" sidebar panel. Shows each agent
 * with their current status and role.
 */
export class TeamTreeView
  implements vscode.TreeDataProvider<TeamTreeItem>
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<TeamTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly agentRegistry: AgentRegistry) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TeamTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TeamTreeItem): TeamTreeItem[] {
    if (element) {
      // Child items: show agent details
      return this.getAgentDetails(element.agentId);
    }

    // Root: list all agents
    const agents = this.agentRegistry.getAllAgents();
    if (agents.length === 0) {
      return [];
    }

    return agents.map((agent) => {
      const state = agent.getState();
      const item = new TeamTreeItem(
        `${agent.roleConfig.icon} ${agent.roleConfig.name}`,
        vscode.TreeItemCollapsibleState.Collapsed,
        agent.id
      );
      item.description = this.statusLabel(state.status);
      item.iconPath = this.statusIcon(state.status);
      item.contextValue = 'agent';
      return item;
    });
  }

  private getAgentDetails(agentId: string): TeamTreeItem[] {
    const agent = this.agentRegistry.getAgent(agentId);
    if (!agent) return [];

    const state = agent.getState();
    const items: TeamTreeItem[] = [];

    items.push(
      new TeamTreeItem(
        `Role: ${agent.roleConfig.role}`,
        vscode.TreeItemCollapsibleState.None,
        agentId
      )
    );

    items.push(
      new TeamTreeItem(
        `Status: ${this.statusLabel(state.status)}`,
        vscode.TreeItemCollapsibleState.None,
        agentId
      )
    );

    if (state.currentTaskId) {
      items.push(
        new TeamTreeItem(
          `Current Task: ${state.currentTaskId}`,
          vscode.TreeItemCollapsibleState.None,
          agentId
        )
      );
    }

    items.push(
      new TeamTreeItem(
        `Completed: ${state.completedTaskIds.length} tasks`,
        vscode.TreeItemCollapsibleState.None,
        agentId
      )
    );

    if (state.blockerDescription) {
      const blocker = new TeamTreeItem(
        `BLOCKER: ${state.blockerDescription}`,
        vscode.TreeItemCollapsibleState.None,
        agentId
      );
      blocker.iconPath = new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('errorForeground')
      );
      items.push(blocker);
    }

    return items;
  }

  private statusLabel(status: AgentStatus): string {
    switch (status) {
      case AgentStatus.Idle:
        return 'Idle';
      case AgentStatus.Working:
        return 'Working...';
      case AgentStatus.Blocked:
        return 'BLOCKED';
      case AgentStatus.WaitingForReview:
        return 'Awaiting Review';
      case AgentStatus.WaitingForDependency:
        return 'Waiting on Dependency';
      case AgentStatus.Error:
        return 'Error';
      case AgentStatus.Done:
        return 'Done';
    }
  }

  private statusIcon(status: AgentStatus): vscode.ThemeIcon {
    switch (status) {
      case AgentStatus.Idle:
        return new vscode.ThemeIcon('circle-outline');
      case AgentStatus.Working:
        return new vscode.ThemeIcon(
          'sync~spin',
          new vscode.ThemeColor('charts.green')
        );
      case AgentStatus.Blocked:
        return new vscode.ThemeIcon(
          'error',
          new vscode.ThemeColor('errorForeground')
        );
      case AgentStatus.WaitingForReview:
        return new vscode.ThemeIcon('eye');
      case AgentStatus.WaitingForDependency:
        return new vscode.ThemeIcon('clock');
      case AgentStatus.Error:
        return new vscode.ThemeIcon(
          'circle-slash',
          new vscode.ThemeColor('errorForeground')
        );
      case AgentStatus.Done:
        return new vscode.ThemeIcon(
          'pass-filled',
          new vscode.ThemeColor('charts.green')
        );
    }
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

class TeamTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly agentId: string
  ) {
    super(label, collapsibleState);
  }
}
