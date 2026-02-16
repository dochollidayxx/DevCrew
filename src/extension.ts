import * as vscode from 'vscode';
import { MessageBus } from './communication/messageBus';
import { FileManager } from './fileops/fileManager';
import { TaskBoard } from './orchestration/taskBoard';
import { Scheduler } from './orchestration/scheduler';
import { AgentRegistry } from './agents/registry';
import { TeamTreeView } from './ui/teamTreeView';
import { TaskTreeView } from './ui/taskTreeView';
import { ActivityTreeView } from './ui/activityTreeView';
import { DevCrewStatusBar } from './ui/statusBar';
import { DashboardPanel } from './ui/dashboardPanel';
import { getConfig, validateConfig } from './config/settings';
import { VSCodeLLMService } from './config/llmProviders';
import { AgentRole } from './types';

let devCrew: DevCrewInstance | null = null;

/**
 * Holds all the runtime components of a DevCrew session.
 */
interface DevCrewInstance {
  messageBus: MessageBus;
  fileManager: FileManager;
  taskBoard: TaskBoard;
  scheduler: Scheduler;
  agentRegistry: AgentRegistry;
  teamTreeView: TeamTreeView;
  taskTreeView: TaskTreeView;
  activityTreeView: ActivityTreeView;
  statusBar: DevCrewStatusBar;
}

export function activate(context: vscode.ExtensionContext): void {
  // ─── Start Team Command ─────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('devcrew.startTeam', async () => {
      if (devCrew) {
        vscode.window.showWarningMessage('DevCrew team is already running.');
        return;
      }

      const config = getConfig();
      const issues = validateConfig(config);

      if (issues.length > 0) {
        const action = await vscode.window.showErrorMessage(
          `DevCrew configuration issues:\n${issues.join('\n')}`,
          'Open Settings'
        );
        if (action === 'Open Settings') {
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'devcrew'
          );
        }
        return;
      }

      try {
        // Initialize LLM via VSCode's Language Model API (GitHub Copilot)
        const llm = new VSCodeLLMService();
        await llm.initialize();

        // Create core services
        const messageBus = new MessageBus();
        const fileManager = new FileManager(
          config.fileOps.requireApproval,
          config.fileOps.autoSave
        );
        const taskBoard = new TaskBoard();
        const agentRegistry = new AgentRegistry(
          messageBus,
          fileManager,
          taskBoard,
          llm
        );

        // Build the team
        const roles: AgentRole[] = ['team-lead', ...config.team.composition];
        agentRegistry.buildTeam(roles);

        // Create scheduler
        const scheduler = new Scheduler(
          agentRegistry,
          taskBoard,
          config.team.maxParallelAgents
        );

        // Create UI components
        const teamTreeView = new TeamTreeView(agentRegistry);
        const taskTreeView = new TaskTreeView(taskBoard);
        const activityTreeView = new ActivityTreeView(messageBus);
        const statusBar = new DevCrewStatusBar(taskBoard, agentRegistry);

        // Register tree views
        context.subscriptions.push(
          vscode.window.registerTreeDataProvider(
            'devcrew-team',
            teamTreeView
          ),
          vscode.window.registerTreeDataProvider(
            'devcrew-tasks',
            taskTreeView
          ),
          vscode.window.registerTreeDataProvider(
            'devcrew-activity',
            activityTreeView
          )
        );

        // Refresh team tree when agent states change
        for (const agent of agentRegistry.getAllAgents()) {
          agent.onStateChange(() => teamTreeView.refresh());
        }

        // Start everything
        agentRegistry.startAll();
        scheduler.start();
        statusBar.show();

        devCrew = {
          messageBus,
          fileManager,
          taskBoard,
          scheduler,
          agentRegistry,
          teamTreeView,
          taskTreeView,
          activityTreeView,
          statusBar,
        };

        const teamSize = agentRegistry.getAllAgents().length;
        vscode.window.showInformationMessage(
          `DevCrew started with ${teamSize} agents using ${llm.modelName}. Use "DevCrew: Assign Task" to get started.`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to start DevCrew: ${msg}`);
      }
    })
  );

  // ─── Stop Team Command ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('devcrew.stopTeam', () => {
      if (!devCrew) {
        vscode.window.showWarningMessage('No DevCrew team is running.');
        return;
      }

      devCrew.scheduler.dispose();
      devCrew.agentRegistry.disposeAll();
      devCrew.messageBus.dispose();
      devCrew.fileManager.dispose();
      devCrew.taskBoard.dispose();
      devCrew.statusBar.dispose();
      devCrew.teamTreeView.dispose();
      devCrew.taskTreeView.dispose();
      devCrew.activityTreeView.dispose();
      devCrew = null;

      vscode.window.showInformationMessage('DevCrew team stopped.');
    })
  );

  // ─── Assign Task Command ────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('devcrew.assignTask', async () => {
      if (!devCrew) {
        vscode.window.showWarningMessage(
          'Start the DevCrew team first.'
        );
        return;
      }

      const request = await vscode.window.showInputBox({
        prompt: 'Describe the task for your dev team',
        placeHolder:
          'e.g., "Build a REST API with user authentication and a React frontend"',
        ignoreFocusOut: true,
      });

      if (!request) return;

      const teamLead = devCrew.agentRegistry.getTeamLead();
      if (!teamLead) {
        vscode.window.showErrorMessage('Team Lead not found.');
        return;
      }

      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'DevCrew: Team Lead is analyzing your request...',
          cancellable: true,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            teamLead.stop();
          });

          try {
            await teamLead.handleUserRequest(request);
            progress.report({ message: 'Tasks created! Team is working...' });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(
              `Team Lead error: ${msg}`
            );
          }
        }
      );
    })
  );

  // ─── Show Dashboard Command ─────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('devcrew.showDashboard', () => {
      if (!devCrew) {
        vscode.window.showWarningMessage(
          'Start the DevCrew team first.'
        );
        return;
      }

      DashboardPanel.createOrShow(
        context.extensionUri,
        devCrew.taskBoard,
        devCrew.agentRegistry,
        devCrew.messageBus
      );
    })
  );

  // ─── Chat with Team Lead Command ────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('devcrew.teamChat', async () => {
      if (!devCrew) {
        vscode.window.showWarningMessage(
          'Start the DevCrew team first.'
        );
        return;
      }

      const teamLead = devCrew.agentRegistry.getTeamLead();
      if (!teamLead) {
        vscode.window.showErrorMessage('Team Lead not found.');
        return;
      }

      const message = await vscode.window.showInputBox({
        prompt: 'Chat with Team Lead',
        placeHolder:
          'Ask about progress, give feedback, or request changes...',
        ignoreFocusOut: true,
      });

      if (!message) return;

      try {
        const response = await teamLead.chatWithUser(message);

        // Show response in an output channel
        const channel = vscode.window.createOutputChannel(
          'DevCrew: Team Lead Chat'
        );
        channel.appendLine(`You: ${message}`);
        channel.appendLine(`Team Lead: ${response}`);
        channel.show();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Team Lead error: ${msg}`);
      }
    })
  );
}

export function deactivate(): void {
  if (devCrew) {
    devCrew.scheduler.dispose();
    devCrew.agentRegistry.disposeAll();
    devCrew.messageBus.dispose();
    devCrew.fileManager.dispose();
    devCrew.taskBoard.dispose();
    devCrew.statusBar.dispose();
    devCrew = null;
  }
}
