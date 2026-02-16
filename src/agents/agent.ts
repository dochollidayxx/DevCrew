import * as vscode from 'vscode';
import {
  AgentRoleConfig,
  AgentState,
  AgentStatus,
  FileEdit,
  LLMMessage,
  LLMService,
  Message,
  MessageType,
  Task,
} from '../types';
import { MessageBus } from '../communication/messageBus';
import { FileManager } from '../fileops/fileManager';

/**
 * Base class for all DevCrew agents. Each agent has a role, maintains
 * conversation context with the LLM, can read/write files through the
 * FileManager, and communicates with other agents via the MessageBus.
 */
export abstract class Agent {
  readonly id: string;
  readonly roleConfig: AgentRoleConfig;
  protected state: AgentState;
  protected conversationHistory: LLMMessage[] = [];
  protected outputChannel: vscode.OutputChannel;

  private readonly messageBus: MessageBus;
  protected readonly fileManager: FileManager;
  protected readonly llm: LLMService;
  private readonly _onStateChange = new vscode.EventEmitter<AgentState>();
  readonly onStateChange = this._onStateChange.event;

  private messageSubscription: vscode.Disposable | undefined;
  private abortController: AbortController | null = null;

  constructor(
    roleConfig: AgentRoleConfig,
    messageBus: MessageBus,
    fileManager: FileManager,
    llm: LLMService
  ) {
    this.id = `agent-${roleConfig.role}-${Date.now()}`;
    this.roleConfig = roleConfig;
    this.messageBus = messageBus;
    this.fileManager = fileManager;
    this.llm = llm;
    this.outputChannel = vscode.window.createOutputChannel(
      `DevCrew: ${roleConfig.name}`
    );

    this.state = {
      id: this.id,
      role: roleConfig.role,
      name: roleConfig.name,
      status: AgentStatus.Idle,
      currentTaskId: null,
      completedTaskIds: [],
      blockerDescription: null,
      lastActivity: new Date(),
    };

    // Initialize system prompt
    this.conversationHistory.push({
      role: 'system',
      content: this.buildSystemPrompt(),
    });
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  start(): void {
    this.messageSubscription = this.messageBus.subscribe(
      this.id,
      (msg) => this.handleMessage(msg)
    );
    this.log(`Agent started: ${this.roleConfig.name} (${this.roleConfig.role})`);
  }

  stop(): void {
    this.abortController?.abort();
    this.messageSubscription?.dispose();
    this.setStatus(AgentStatus.Idle);
    this.log(`Agent stopped: ${this.roleConfig.name}`);
  }

  /**
   * Pause the agent. Aborts current execution but retains conversation
   * history so work can resume from context.
   */
  pause(): void {
    this.abortController?.abort();
    this.state.currentTaskId = null;
    this.setStatus(AgentStatus.Paused);
    this.log(`Agent paused: ${this.roleConfig.name}`);
  }

  /**
   * Resume a paused agent. Restores to Idle so the scheduler
   * can dispatch new (or re-queued) tasks to it.
   */
  resume(): void {
    if (
      this.state.status !== AgentStatus.Paused &&
      this.state.status !== AgentStatus.Error
    ) {
      return;
    }
    this.abortController = null;
    this.state.currentTaskId = null;
    this.state.blockerDescription = null;
    this.setStatus(AgentStatus.Idle);
    this.log(`Agent resumed: ${this.roleConfig.name}`);
  }

  dispose(): void {
    this.stop();
    this._onStateChange.dispose();
    this.outputChannel.dispose();
  }

  // ─── Task Execution ───────────────────────────────────────────────────

  async executeTask(task: Task): Promise<void> {
    this.state.currentTaskId = task.id;
    this.setStatus(AgentStatus.Working);
    this.log(`Starting task: ${task.title}`);

    this.abortController = new AbortController();

    try {
      // Add task context to conversation
      this.conversationHistory.push({
        role: 'user',
        content: this.buildTaskPrompt(task),
      });

      // Iterative execution loop
      let iteration = 0;
      const maxIterations = 20;

      while (iteration < maxIterations && !this.abortController.signal.aborted) {
        iteration++;
        this.log(`Iteration ${iteration}/${maxIterations}`);

        const response = await this.llm.sendMessages(this.conversationHistory);

        this.conversationHistory.push({
          role: 'assistant',
          content: response,
        });

        // Parse the response for actions
        const actions = this.parseActions(response);

        if (actions.length === 0) {
          // No more actions - agent considers task done
          break;
        }

        // Execute actions
        for (const action of actions) {
          if (this.abortController.signal.aborted) break;

          const result = await this.executeAction(action, task);
          this.conversationHistory.push({
            role: 'user',
            content: `Action result:\n${result}`,
          });
        }

        // Check if agent signaled completion
        if (actions.some((a) => a.type === 'complete')) {
          break;
        }
      }

      // Report completion
      this.sendMessage(MessageType.TaskCompleted, null, {
        taskId: task.id,
        summary: this.conversationHistory[this.conversationHistory.length - 1]?.content,
      });

      this.state.completedTaskIds.push(task.id);
      this.state.currentTaskId = null;
      this.setStatus(AgentStatus.Idle);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log(`Task failed: ${errorMsg}`);
      this.sendMessage(MessageType.TaskFailed, null, {
        taskId: task.id,
        error: errorMsg,
      });
      this.setStatus(AgentStatus.Error);
    }
  }

  // ─── LLM Response Parsing ────────────────────────────────────────────

  protected parseActions(content: string): AgentAction[] {
    const actions: AgentAction[] = [];

    // Parse structured action blocks from LLM response
    // Format: <action type="...">...</action>
    const actionRegex = /<action\s+type="(\w+)"(?:\s+[^>]*)?>([^]*?)<\/action>/g;
    let match;

    while ((match = actionRegex.exec(content)) !== null) {
      const type = match[1] as AgentAction['type'];
      const body = match[2].trim();

      switch (type) {
        case 'write_file': {
          const pathMatch = body.match(/path="([^"]+)"/);
          const contentMatch = body.match(/<content>([^]*?)<\/content>/);
          if (pathMatch && contentMatch) {
            actions.push({
              type: 'write_file',
              filePath: pathMatch[1],
              content: contentMatch[1],
            });
          }
          break;
        }
        case 'read_file': {
          const pathMatch = body.match(/path="([^"]+)"/);
          if (pathMatch) {
            actions.push({ type: 'read_file', filePath: pathMatch[1] });
          }
          break;
        }
        case 'ask': {
          const toMatch = body.match(/to="([^"]+)"/);
          actions.push({
            type: 'ask',
            targetAgentId: toMatch?.[1] ?? null,
            question: body.replace(/to="[^"]+"/, '').trim(),
          });
          break;
        }
        case 'blocker': {
          actions.push({ type: 'blocker', description: body });
          break;
        }
        case 'status': {
          actions.push({ type: 'status', message: body });
          break;
        }
        case 'complete': {
          actions.push({ type: 'complete', summary: body });
          break;
        }
        default: {
          this.log(`Unknown action type: ${type}`);
        }
      }
    }

    return actions;
  }

  protected async executeAction(
    action: AgentAction,
    task: Task
  ): Promise<string> {
    switch (action.type) {
      case 'write_file': {
        return this.handleWriteFile(action, task);
      }
      case 'read_file': {
        return this.handleReadFile(action);
      }
      case 'ask': {
        return this.handleAsk(action);
      }
      case 'blocker': {
        this.setStatus(AgentStatus.Blocked);
        this.state.blockerDescription = action.description;
        this.sendMessage(MessageType.BlockerRaised, null, {
          taskId: task.id,
          description: action.description,
        });
        return `Blocker reported: ${action.description}`;
      }
      case 'status': {
        this.sendMessage(MessageType.StatusUpdate, null, {
          taskId: task.id,
          message: action.message,
        });
        return 'Status update sent.';
      }
      case 'complete': {
        return `Task marked as complete: ${action.summary}`;
      }
      default:
        return 'Unknown action.';
    }
  }

  // ─── File Operations ──────────────────────────────────────────────────

  private async handleWriteFile(
    action: WriteFileAction,
    task: Task
  ): Promise<string> {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        return 'Error: No workspace folder open.';
      }

      const fileUri = vscode.Uri.joinPath(
        workspaceFolders[0].uri,
        action.filePath
      );

      const edit: FileEdit = {
        uri: fileUri,
        type: 'create',
        content: action.content,
        agentId: this.id,
        taskId: task.id,
        description: `${this.roleConfig.name}: writing ${action.filePath}`,
      };

      await this.fileManager.applyEdit(edit);
      return `File written: ${action.filePath}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error writing file: ${msg}`;
    }
  }

  private async handleReadFile(action: ReadFileAction): Promise<string> {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        return 'Error: No workspace folder open.';
      }

      const fileUri = vscode.Uri.joinPath(
        workspaceFolders[0].uri,
        action.filePath
      );

      const content = await this.fileManager.readFile(fileUri);
      return `File contents of ${action.filePath}:\n${content}`;
    } catch (err) {
      return `Error reading file: ${action.filePath} not found or unreadable.`;
    }
  }

  private handleAsk(action: AskAction): string {
    this.sendMessage(MessageType.Question, action.targetAgentId, {
      question: action.question,
    });
    return `Question sent${action.targetAgentId ? ` to ${action.targetAgentId}` : ' to team'}.`;
  }

  // ─── Messaging ────────────────────────────────────────────────────────

  protected sendMessage(
    type: MessageType,
    toAgentId: string | null,
    payload: unknown
  ): void {
    this.messageBus.publish({
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      fromAgentId: this.id,
      toAgentId,
      payload,
      timestamp: new Date(),
      replyToMessageId: null,
    });
  }

  protected abstract handleMessage(message: Message): void;

  // ─── Prompt Building ──────────────────────────────────────────────────

  protected buildSystemPrompt(): string {
    return [
      `You are ${this.roleConfig.name}, a ${this.roleConfig.description}.`,
      `You are part of a development team called DevCrew.`,
      '',
      `Your capabilities: ${this.roleConfig.capabilities.join(', ')}`,
      '',
      this.roleConfig.systemPrompt,
      '',
      `To perform actions, use XML action tags:`,
      `<action type="write_file">path="relative/path"<content>file content here</content></action>`,
      `<action type="read_file">path="relative/path"</action>`,
      `<action type="ask">to="agent-id" Your question here</action>`,
      `<action type="status">Your status message</action>`,
      `<action type="blocker">Description of what's blocking you</action>`,
      `<action type="complete">Summary of what you accomplished</action>`,
    ].join('\n');
  }

  protected buildTaskPrompt(task: Task): string {
    return [
      `## Assigned Task: ${task.title}`,
      '',
      task.description,
      '',
      `Priority: ${task.priority}`,
      task.dependsOn.length > 0
        ? `Dependencies: ${task.dependsOn.join(', ')}`
        : '',
      '',
      `Work iteratively: read files, plan, write code, then report completion.`,
      `Use action tags to interact with the filesystem and team.`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  // ─── State Management ─────────────────────────────────────────────────

  protected setStatus(status: AgentStatus): void {
    this.state.status = status;
    this.state.lastActivity = new Date();
    this._onStateChange.fire({ ...this.state });
  }

  getState(): AgentState {
    return { ...this.state };
  }

  protected log(message: string): void {
    const timestamp = new Date().toISOString().slice(11, 23);
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
  }
}

// ─── Action Types ─────────────────────────────────────────────────────────────

interface WriteFileAction {
  type: 'write_file';
  filePath: string;
  content: string;
}

interface ReadFileAction {
  type: 'read_file';
  filePath: string;
}

interface AskAction {
  type: 'ask';
  targetAgentId: string | null;
  question: string;
}

interface BlockerAction {
  type: 'blocker';
  description: string;
}

interface StatusAction {
  type: 'status';
  message: string;
}

interface CompleteAction {
  type: 'complete';
  summary: string;
}

type AgentAction =
  | WriteFileAction
  | ReadFileAction
  | AskAction
  | BlockerAction
  | StatusAction
  | CompleteAction;
