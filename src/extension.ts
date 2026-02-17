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
import { SummaryPanel } from './ui/summaryPanel';
import { getConfig, validateConfig } from './config/settings';
import { VSCodeLLMService } from './config/llmProviders';
import { Agent } from './agents/agent';
import { TeamLeadAgent } from './agents/teamLeadAgent';

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
        // Initialize LLM via VSCode's Language Model API
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

        // Build the team (creates only the Team Lead; specialists are added dynamically)
        agentRegistry.buildTeam();

        // Create scheduler
        const scheduler = new Scheduler(
          agentRegistry,
          taskBoard,
          config.team.maxParallelAgents,
          config.agent.maxIterationsPerTask
        );

        // Create UI components
        const teamTreeView = new TeamTreeView(agentRegistry);
        const taskTreeView = new TaskTreeView(taskBoard);
        const activityTreeView = new ActivityTreeView(messageBus);
        const statusBar = new DevCrewStatusBar(taskBoard, agentRegistry, scheduler);

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

        // Refresh UI when agents are added/removed or change state
        const wireAgentUI = (agent: Agent) => {
          agent.onStateChange(() => teamTreeView.refresh());
        };
        // Wire existing agents (just TeamLead at this point)
        for (const agent of agentRegistry.getAllAgents()) {
          wireAgentUI(agent);
        }
        // Wire future dynamically-created agents
        agentRegistry.onAgentAdded((agent) => {
          wireAgentUI(agent);
          teamTreeView.refresh();
        });
        agentRegistry.onAgentRemoved(() => {
          teamTreeView.refresh();
        });

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

        vscode.window.showInformationMessage(
          `DevCrew Team Lead started using ${llm.modelName}. Use "DevCrew: Assign Task" to get started.`
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
      devCrew.agentRegistry.dispose();
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

  // ─── Pause Team Command ─────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('devcrew.pauseTeam', () => {
      if (!devCrew) {
        vscode.window.showWarningMessage('No DevCrew team is running.');
        return;
      }

      if (devCrew.scheduler.getIsPaused()) {
        vscode.window.showWarningMessage('DevCrew team is already paused.');
        return;
      }

      devCrew.agentRegistry.pauseAll();
      devCrew.scheduler.pause();

      const stats = devCrew.taskBoard.getStats();
      vscode.window.showInformationMessage(
        `DevCrew paused. ${stats.paused} tasks shelved, ${stats.completed} already completed. Use "DevCrew: Resume Team" to continue.`
      );
    })
  );

  // ─── Resume Team Command ───────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('devcrew.resumeTeam', () => {
      if (!devCrew) {
        vscode.window.showWarningMessage('No DevCrew team is running.');
        return;
      }

      if (!devCrew.scheduler.getIsPaused()) {
        vscode.window.showWarningMessage(
          'DevCrew team is not paused.'
        );
        return;
      }

      devCrew.agentRegistry.resumeAll();
      devCrew.scheduler.resume();

      const stats = devCrew.taskBoard.getStats();
      vscode.window.showInformationMessage(
        `DevCrew resumed! ${stats.pending} tasks queued for dispatch, ${stats.completed} already completed.`
      );
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
          title: 'DevCrew',
          cancellable: true,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            teamLead.stop();
          });

          // Wire up streaming progress from Team Lead to the notification
          const teamLeadAgent = teamLead as TeamLeadAgent;
          teamLeadAgent.onProgress = (message: string) => {
            progress.report({ message });
          };

          // Wire up completion callback to open the summary panel
          teamLeadAgent.onComplete = () => {
            SummaryPanel.createOrShow(
              devCrew!.taskBoard,
              devCrew!.agentRegistry
            );
          };

          try {
            progress.report({ message: 'Team Lead is analyzing your request...' });
            await teamLeadAgent.handleUserRequest(request);
            progress.report({ message: 'Tasks created! Team is working...' });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(
              `Team Lead error: ${msg}`
            );
          } finally {
            teamLeadAgent.onProgress = null;
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
    devCrew.agentRegistry.dispose();
    devCrew.messageBus.dispose();
    devCrew.fileManager.dispose();
    devCrew.taskBoard.dispose();
    devCrew.statusBar.dispose();
    devCrew = null;
  }
}
