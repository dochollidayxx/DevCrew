import * as vscode from 'vscode';
import * as cp from 'child_process';
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
  private pendingQuestions: Map<string, { resolve: (answer: string) => void; timeout: ReturnType<typeof setTimeout> }> = new Map();

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

  async executeTask(task: Task): Promise<string> {
    this.state.currentTaskId = task.id;
    this.setStatus(AgentStatus.Working);
    this.log(`Starting task: ${task.title}`);

    this.abortController = new AbortController();
    const filesWritten: string[] = [];

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

          // Track files written during this task
          if (action.type === 'write_file') {
            filesWritten.push(action.filePath);
          }

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

      // Extract completion summary
      const completeAction = this.parseActions(
        this.conversationHistory[this.conversationHistory.length - 1]?.content ?? ''
      ).find(a => a.type === 'complete') as CompleteAction | undefined;
      const completionSummary = completeAction?.summary
        ?? this.conversationHistory[this.conversationHistory.length - 1]?.content?.slice(0, 2000)
        ?? 'Task completed';

      // Report completion with file provenance
      this.sendMessage(MessageType.TaskCompleted, null, {
        taskId: task.id,
        summary: completionSummary,
        filesWritten,
      });

      this.state.completedTaskIds.push(task.id);
      this.state.currentTaskId = null;
      this.setStatus(AgentStatus.Idle);
      return completionSummary;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log(`Task failed: ${errorMsg}`);
      this.sendMessage(MessageType.TaskFailed, null, {
        taskId: task.id,
        error: errorMsg,
      });
      this.setStatus(AgentStatus.Error);
      throw err;
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
        case 'list_files': {
          const pathMatch = body.match(/path="([^"]+)"/);
          const patternMatch = body.match(/pattern="([^"]+)"/);
          actions.push({
            type: 'list_files',
            dirPath: pathMatch?.[1] ?? '.',
            pattern: patternMatch?.[1] ?? '**/*',
          });
          break;
        }
        case 'run_command': {
          const cmdMatch = body.match(/command="([^"]+)"/);
          const cwdMatch = body.match(/cwd="([^"]+)"/);
          const timeoutMatch = body.match(/timeout="([^"]+)"/);
          if (cmdMatch) {
            actions.push({
              type: 'run_command',
              command: cmdMatch[1],
              cwd: cwdMatch?.[1],
              timeout: timeoutMatch ? parseInt(timeoutMatch[1], 10) : undefined,
            });
          }
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
        return await this.handleAsk(action);
      }
      case 'list_files': {
        return this.handleListFiles(action);
      }
      case 'run_command': {
        return this.handleRunCommand(action, task);
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

      // Determine if this is a create or replace based on file existence
      let editType: 'create' | 'replace' = 'create';
      try {
        await vscode.workspace.fs.stat(fileUri);
        editType = 'replace'; // File exists — replace contents
      } catch {
        // File doesn't exist — create it
      }

      const edit: FileEdit = {
        uri: fileUri,
        type: editType,
        content: action.content,
        agentId: this.id,
        taskId: task.id,
        description: `${this.roleConfig.name}: ${editType === 'create' ? 'creating' : 'updating'} ${action.filePath}`,
      };

      await this.fileManager.applyEdit(edit);
      return `File ${editType === 'create' ? 'created' : 'updated'}: ${action.filePath}`;
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
      return `Error reading file: ${action.filePath} not found or unreadable. Use <action type="list_files">path="." pattern="**/*"</action> to discover available files.`;
    }
  }

  private async handleAsk(action: AskAction): Promise<string> {
    const questionId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const answerPromise = new Promise<string>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingQuestions.delete(questionId);
        resolve('No response received (timeout)');
      }, 30_000);

      this.pendingQuestions.set(questionId, { resolve, timeout });
    });

    this.sendMessage(MessageType.Question, action.targetAgentId, {
      questionId,
      question: action.question,
    });

    const answer = await answerPromise;
    return `Answer received: ${answer}`;
  }

  protected resolveAnswer(questionId: string, answer: string): void {
    const pending = this.pendingQuestions.get(questionId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingQuestions.delete(questionId);
      pending.resolve(answer);
    }
  }

  protected handleAnswerMessage(message: Message): void {
    const payload = message.payload as { questionId?: string; answer?: string };
    const answer = payload.answer ?? JSON.stringify(message.payload);

    if (payload.questionId) {
      this.resolveAnswer(payload.questionId, answer);
    } else {
      // Backwards compat: resolve most recent pending question
      const keys = Array.from(this.pendingQuestions.keys());
      if (keys.length > 0) {
        this.resolveAnswer(keys[keys.length - 1], answer);
      }
    }
  }

  private async handleListFiles(action: ListFilesAction): Promise<string> {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        return 'Error: No workspace folder open.';
      }

      const baseUri = vscode.Uri.joinPath(workspaceFolders[0].uri, action.dirPath);
      const files = await this.fileManager.listFiles(baseUri, action.pattern);
      const relativePaths = files.map(f => vscode.workspace.asRelativePath(f));
      if (relativePaths.length === 0) {
        return `No files found matching pattern "${action.pattern}" in "${action.dirPath}". Try a broader pattern like "**/*" or a different directory. Use path="." to search from the workspace root.`;
      }
      return `Found ${relativePaths.length} files:\n${relativePaths.join('\n')}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error listing files: ${msg}`;
    }
  }

  private async handleRunCommand(action: RunCommandAction, task: Task): Promise<string> {
    const ALLOWED_COMMANDS = ['npm', 'npx', 'yarn', 'pnpm', 'node', 'tsc', 'eslint', 'jest', 'vitest', 'git', 'cat', 'ls', 'find', 'grep'];
    const DANGEROUS_PATTERNS = /[;`]|\$\(|&&|\|\|/;

    const firstWord = action.command.split(/\s+/)[0];
    if (!ALLOWED_COMMANDS.includes(firstWord)) {
      return `Error: Command '${firstWord}' is not in the allow-list. Allowed: ${ALLOWED_COMMANDS.join(', ')}`;
    }

    if (DANGEROUS_PATTERNS.test(action.command)) {
      return 'Error: Command contains dangerous shell metacharacters.';
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return 'Error: No workspace folder open.';
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const cwd = action.cwd
      ? vscode.Uri.joinPath(workspaceFolders[0].uri, action.cwd).fsPath
      : workspaceRoot;

    const timeout = Math.min(action.timeout ?? 30_000, 300_000);

    return new Promise<string>((resolve) => {
      cp.exec(action.command, { cwd, timeout }, (error, stdout, stderr) => {
        if (error) {
          const output = (stderr || error.message).slice(0, 10_000);
          resolve(`Command failed:\n${output}`);
        } else {
          const output = stdout.slice(0, 10_000);
          resolve(output || '(no output)');
        }
      });
    });
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
      `<action type="list_files">path="relative/dir" pattern="**/*.ts"</action>`,
      `<action type="run_command">command="npm test" cwd="optional/subdir" timeout="60000"</action>`,
      `<action type="ask">to="agent-id" Your question here</action>`,
      `<action type="status">Your status message</action>`,
      `<action type="blocker">Description of what's blocking you</action>`,
      `<action type="complete">Summary of what you accomplished</action>`,
    ].join('\n');
  }

  protected buildTaskPrompt(task: Task): string {
    const depResults = task.metadata['dependencyResults'] as Array<{
      taskId: string;
      title: string;
      summary: string;
      filesWritten?: string[];
    }> | undefined;

    const depContext: string[] = [];
    if (depResults?.length) {
      depContext.push('', '## Completed Dependencies:');
      for (const d of depResults) {
        depContext.push(`### ${d.title}`);
        depContext.push(d.summary?.slice(0, 1000) ?? 'No summary');
        if (d.filesWritten?.length) {
          depContext.push(`\nFiles created/modified by this task (read these for context):`);
          for (const f of d.filesWritten) {
            depContext.push(`- ${f}`);
          }
        }
      }
    }

    return [
      `## Assigned Task: ${task.title}`,
      '',
      task.description,
      '',
      `Priority: ${task.priority}`,
      task.dependsOn.length > 0
        ? `Dependencies: ${task.dependsOn.join(', ')}`
        : '',
      ...depContext,
      '',
      `Work iteratively: use list_files and read_file first to understand the project, then plan, write code, and report completion.`,
      `Use action tags to interact with the filesystem and team.`,
      depResults?.some(d => d.filesWritten?.length)
        ? `IMPORTANT: Start by reading the files listed above from your dependencies to understand the contracts and interfaces you must conform to.`
        : '',
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

interface ListFilesAction {
  type: 'list_files';
  dirPath: string;
  pattern: string;
}

interface RunCommandAction {
  type: 'run_command';
  command: string;
  cwd?: string;
  timeout?: number;
}

type AgentAction =
  | WriteFileAction
  | ReadFileAction
  | AskAction
  | BlockerAction
  | StatusAction
  | CompleteAction
  | ListFilesAction
  | RunCommandAction;
