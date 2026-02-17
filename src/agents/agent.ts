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
  TASK_METADATA,
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
   * Cancel the agent's current task. Aborts execution but keeps the
   * agent alive and Idle so it can be re-dispatched immediately.
   * Unlike stop(): does NOT dispose the message subscription.
   * Unlike pause(): sets status to Idle, not Paused.
   */
  cancelCurrentTask(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.state.currentTaskId = null;
    this.setStatus(AgentStatus.Idle);
    this.log(`Current task cancelled: ${this.roleConfig.name}`);
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

  async executeTask(task: Task, maxIterations: number = 50): Promise<string> {
    this.state.currentTaskId = task.id;
    this.setStatus(AgentStatus.Working);
    this.log(`Starting task: ${task.title}`);

    this.abortController = new AbortController();
    const filesWritten: string[] = [];
    let hitIterationLimit = false;

    try {
      // Add task context to conversation
      this.conversationHistory.push({
        role: 'user',
        content: this.buildTaskPrompt(task),
      });

      // Iterative execution loop
      let iteration = 0;

      while (iteration < maxIterations && !this.abortController.signal.aborted) {
        iteration++;
        this.log(`Iteration ${iteration}/${maxIterations}`);

        // Fire iteration progress
        this.sendMessage(MessageType.IterationProgress, null, {
          taskId: task.id,
          taskTitle: task.title,
          iteration,
          maxIterations,
          agentRole: this.roleConfig.role,
          agentName: this.roleConfig.name,
        });

        let response: string;
        let lastLoggedCharCount = 0;

        try {
          // Inactivity timeout: only fires if no streaming data arrives
          // for 30 seconds. Resets on every chunk so productive streams
          // (even very long ones) are never interrupted.
          const INACTIVITY_MS = 30_000;
          let inactivityTimerId: ReturnType<typeof setTimeout>;
          let rejectInactivity: ((err: Error) => void) | null = null;

          const inactivityPromise = new Promise<never>((_, reject) => {
            rejectInactivity = reject;
            inactivityTimerId = setTimeout(
              () => reject(new Error('Iteration timeout')),
              INACTIVITY_MS
            );
          });

          const resetInactivityTimer = () => {
            clearTimeout(inactivityTimerId);
            inactivityTimerId = setTimeout(
              () => rejectInactivity?.(new Error('Iteration timeout')),
              INACTIVITY_MS
            );
          };

          try {
            response = await Promise.race([
              this.llm.streamWithProgress(
                this.conversationHistory,
                (chunk, accumulated) => {
                  resetInactivityTimer();

                  // Log streaming progress every ~2000 chars for visibility
                  if (accumulated.length - lastLoggedCharCount >= 2000) {
                    lastLoggedCharCount = accumulated.length;
                    this.log(`Iteration ${iteration}/${maxIterations}: received ${accumulated.length} chars...`);
                  }

                  // Fire streaming chunk for live UI updates
                  this.sendMessage(MessageType.StreamingChunk, null, {
                    taskId: task.id,
                    agentRole: this.roleConfig.role,
                    chunk,
                    accumulated: accumulated.slice(-200), // last 200 chars for display
                  });
                }
              ),
              inactivityPromise,
            ]);
          } finally {
            clearTimeout(inactivityTimerId!);
          }
        } catch (err) {
          if (err instanceof Error && err.message === 'Iteration timeout') {
            this.log(`Iteration ${iteration}/${maxIterations} timed out (no data for 30s)`);
            this.conversationHistory.push({
              role: 'user',
              content: 'Your previous response stalled (no output for 30 seconds). Please be more concise and break your work into smaller steps. Continue from where you left off.',
            });
            continue;
          }
          throw err;
        }

        this.conversationHistory.push({
          role: 'assistant',
          content: response,
        });

        // Parse the response for actions
        const actions = this.parseActions(response);

        if (actions.length === 0) {
          // No more actions - agent considers task done
          this.log(`Iteration ${iteration}/${maxIterations}: no actions, finishing`);
          break;
        }

        // Log a summary of what this iteration is doing
        const actionSummary = actions.map(a => {
          switch (a.type) {
            case 'write_file': return `write ${a.filePath}`;
            case 'edit_file': return `edit ${a.filePath}`;
            case 'read_file': return `read ${a.filePath}`;
            case 'list_files': return `list ${a.dirPath}/${a.pattern}`;
            case 'run_command': return `run "${a.command}"`;
            case 'complete': return 'complete';
            case 'status': return 'status';
            case 'ask': return 'ask';
            case 'blocker': return 'blocker';
            default: return a.type;
          }
        }).join(', ');
        this.log(`Iteration ${iteration}/${maxIterations}: ${actionSummary}`);

        // Execute actions
        for (const action of actions) {
          if (this.abortController.signal.aborted) break;

          // Track files written during this task
          if (action.type === 'write_file' || action.type === 'edit_file') {
            filesWritten.push(action.filePath);
          }

          const result = await this.executeAction(action, task);

          // Fire progress messages for user-visible actions
          if (action.type === 'write_file' && !result.startsWith('Error')) {
            this.sendMessage(MessageType.FileWritten, null, {
              taskId: task.id,
              filePath: action.filePath,
              agentRole: this.roleConfig.role,
              agentName: this.roleConfig.name,
            });
          } else if (action.type === 'edit_file' && !result.startsWith('Error')) {
            this.sendMessage(MessageType.FileEdited, null, {
              taskId: task.id,
              filePath: action.filePath,
              agentRole: this.roleConfig.role,
              agentName: this.roleConfig.name,
            });
          } else if (action.type === 'run_command') {
            this.sendMessage(MessageType.CommandExecuted, null, {
              taskId: task.id,
              command: action.command,
              success: !result.startsWith('Command failed') && !result.startsWith('Error'),
              agentRole: this.roleConfig.role,
              agentName: this.roleConfig.name,
            });
          } else if (action.type === 'read_file') {
            this.sendMessage(MessageType.FileRead, null, {
              taskId: task.id,
              filePath: action.filePath,
              agentRole: this.roleConfig.role,
              agentName: this.roleConfig.name,
            });
          } else if (action.type === 'list_files') {
            this.sendMessage(MessageType.FilesListed, null, {
              taskId: task.id,
              dirPath: action.dirPath,
              pattern: action.pattern,
              agentRole: this.roleConfig.role,
              agentName: this.roleConfig.name,
            });
          }

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

      // Detect if we exited because of the iteration limit
      if (iteration >= maxIterations) {
        hitIterationLimit = true;
        this.log(`Hit iteration limit (${maxIterations}) without explicit completion`);
      }

      // Extract completion summary
      const completeAction = this.parseActions(
        this.conversationHistory[this.conversationHistory.length - 1]?.content ?? ''
      ).find(a => a.type === 'complete') as CompleteAction | undefined;

      let completionSummary: string;
      if (completeAction) {
        completionSummary = completeAction.summary;
      } else if (hitIterationLimit) {
        completionSummary = `[INCOMPLETE - hit ${maxIterations} iteration limit] `
          + (this.conversationHistory[this.conversationHistory.length - 1]?.content?.slice(0, 2000) ?? 'No summary');
      } else {
        completionSummary = this.conversationHistory[this.conversationHistory.length - 1]?.content?.slice(0, 2000)
          ?? 'Task completed';
      }

      // Report completion with file provenance
      this.sendMessage(MessageType.TaskCompleted, null, {
        taskId: task.id,
        taskTitle: task.title,
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
        taskTitle: task.title,
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
        case 'edit_file': {
          const pathMatch = body.match(/path="([^"]+)"/);
          const searchMatch = body.match(/<search>([^]*?)<\/search>/);
          const contentMatch = body.match(/<content>([^]*?)<\/content>/);
          if (pathMatch && searchMatch) {
            actions.push({
              type: 'edit_file',
              filePath: pathMatch[1],
              search: searchMatch[1],
              content: contentMatch?.[1] ?? '',
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
        case 'create_agent': {
          const roleTag = body.match(/<role>([^]*?)<\/role>/);
          const nameTag = body.match(/<name>([^]*?)<\/name>/);
          const descTag = body.match(/<description>([^]*?)<\/description>/);
          const promptTag = body.match(/<prompt>([^]*?)<\/prompt>/);
          const capsTag = body.match(/<capabilities>([^]*?)<\/capabilities>/);
          if (roleTag) {
            actions.push({
              type: 'create_agent',
              role: roleTag[1].trim(),
              name: nameTag?.[1].trim() ?? roleTag[1].trim(),
              description: descTag?.[1].trim() ?? '',
              prompt: promptTag?.[1].trim() ?? '',
              capabilities: capsTag
                ? capsTag[1].split(',').map((c) => c.trim()).filter(Boolean)
                : [],
            });
          }
          break;
        }
        case 'remove_agent': {
          actions.push({ type: 'remove_agent', role: body.trim() });
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
      case 'edit_file': {
        return this.handleEditFile(action, task);
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
      case 'create_agent':
      case 'remove_agent':
        return 'Agent management actions are only available to the Team Lead.';
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

  private async handleEditFile(
    action: EditFileAction,
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

      // Read current file content
      let content: string;
      try {
        content = await this.fileManager.readFile(fileUri);
      } catch {
        return `Error: File not found: ${action.filePath}. Use write_file to create new files.`;
      }

      // Find the search text
      const firstIndex = content.indexOf(action.search);
      if (firstIndex === -1) {
        return `Error: Search text not found in ${action.filePath}. Use read_file first to see the exact file contents, then copy the text verbatim.`;
      }

      // Check for multiple matches
      const secondIndex = content.indexOf(action.search, firstIndex + 1);
      if (secondIndex !== -1) {
        return `Error: Search text matches multiple locations in ${action.filePath}. Include more surrounding context to make the match unique.`;
      }

      // Compute range from character offset
      const startOffset = firstIndex;
      const endOffset = firstIndex + action.search.length;

      const before = content.substring(0, startOffset);
      const startLines = before.split('\n');
      const startLine = startLines.length - 1;
      const startChar = startLines[startLines.length - 1].length;

      const beforeEnd = content.substring(0, endOffset);
      const endLines = beforeEnd.split('\n');
      const endLine = endLines.length - 1;
      const endChar = endLines[endLines.length - 1].length;

      const range = new vscode.Range(
        new vscode.Position(startLine, startChar),
        new vscode.Position(endLine, endChar)
      );

      const edit: FileEdit = {
        uri: fileUri,
        type: 'replace',
        range,
        content: action.content,
        agentId: this.id,
        taskId: task.id,
        description: `${this.roleConfig.name}: editing ${action.filePath}`,
      };

      await this.fileManager.applyEdit(edit);
      return `File edited: ${action.filePath}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error editing file: ${msg}`;
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

  private async handleRunCommand(action: RunCommandAction, _task: Task): Promise<string> {
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
      `## Working Style`,
      `Work ITERATIVELY — one action per response, or a small related group.`,
      `Do NOT write all files in a single response. Instead:`,
      `1. First iteration: use list_files / read_file to understand the project`,
      `2. Each subsequent iteration: write ONE file, then stop and let the system process it`,
      `3. After all files are written: use the complete action`,
      `This keeps responses short and lets the system track your progress.`,
      '',
      `To perform actions, use XML action tags:`,
      `<action type="write_file">path="relative/path"<content>file content here</content></action>`,
      `<action type="edit_file">path="relative/path"<search>exact text to find</search><content>replacement text</content></action>`,
      `<action type="read_file">path="relative/path"</action>`,
      `<action type="list_files">path="relative/dir" pattern="**/*.ts"</action>`,
      `<action type="run_command">command="npm test" cwd="optional/subdir" timeout="60000"</action>`,
      `<action type="ask">to="agent-id" Your question here</action>`,
      `<action type="status">Your status message</action>`,
      `<action type="blocker">Description of what's blocking you</action>`,
      `<action type="complete">Summary of what you accomplished</action>`,
      '',
      `## File Editing Guidance`,
      `- write_file: create new files, or rewrite small files entirely`,
      `- edit_file: modify specific parts of existing files (preferred for targeted changes)`,
      `- Always read_file first before using edit_file so you know the exact text to search for`,
      `- The <search> text must match exactly one location in the file`,
      `- Empty <content> deletes the matched text`,
    ].join('\n');
  }

  protected buildTaskPrompt(task: Task): string {
    const depResults = task.metadata[TASK_METADATA.dependencyResults] as Array<{
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

interface EditFileAction {
  type: 'edit_file';
  filePath: string;
  search: string;
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

interface CreateAgentAction {
  type: 'create_agent';
  role: string;
  name: string;
  description: string;
  prompt: string;
  capabilities: string[];
}

interface RemoveAgentAction {
  type: 'remove_agent';
  role: string;
}

export type AgentAction =
  | WriteFileAction
  | EditFileAction
  | ReadFileAction
  | AskAction
  | BlockerAction
  | StatusAction
  | CompleteAction
  | ListFilesAction
  | RunCommandAction
  | CreateAgentAction
  | RemoveAgentAction;
