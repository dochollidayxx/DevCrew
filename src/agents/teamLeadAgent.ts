import * as vscode from 'vscode';
import {
  AgentRoleConfig,
  AgentStatus,
  LLMService,
  Message,
  MessageType,
  Task,
  TaskPriority,
  TaskStatus,
} from '../types';
import { Agent } from './agent';
import { MessageBus } from '../communication/messageBus';
import { FileManager } from '../fileops/fileManager';
import { TaskBoard } from '../orchestration/taskBoard';

/**
 * The Team Lead is the orchestrating agent. It:
 * - Receives user requests and decomposes them into tasks
 * - Assigns tasks to specialists based on their roles
 * - Monitors progress and resolves blockers
 * - Integrates work from multiple agents
 * - Communicates status back to the user
 */
export class TeamLeadAgent extends Agent {
  private teamMembers: Agent[] = [];
  private readonly taskBoard: TaskBoard;
  private integrationQueue: string[] = [];

  constructor(
    roleConfig: AgentRoleConfig,
    messageBus: MessageBus,
    fileManager: FileManager,
    taskBoard: TaskBoard,
    llm: LLMService
  ) {
    super(roleConfig, messageBus, fileManager, llm);
    this.taskBoard = taskBoard;
  }

  setTeamMembers(members: Agent[]): void {
    this.teamMembers = members;
  }

  // ─── User-Facing Entry Point ──────────────────────────────────────────

  /**
   * Main entry point: user gives a high-level request, Team Lead
   * decomposes it into tasks and orchestrates the team.
   */
  async handleUserRequest(request: string): Promise<void> {
    this.setStatus(AgentStatus.Working);
    this.log(`Received user request: ${request}`);

    // Build context about the team for the LLM
    const teamContext = this.buildTeamContext();

    this.conversationHistory.push({
      role: 'user',
      content: [
        `## User Request`,
        request,
        '',
        `## Your Team`,
        teamContext,
        '',
        `## Instructions`,
        `Analyze this request and decompose it into concrete tasks.`,
        `For each task, specify:`,
        `- A clear title and description`,
        `- Which team member role should handle it (${this.teamMembers.map((m) => m.roleConfig.role).join(', ')})`,
        `- Dependencies on other tasks (by title reference)`,
        `- Priority: critical, high, medium, or low`,
        '',
        `Output your plan as a series of <task> blocks:`,
        `<task>`,
        `  <title>Task title</title>`,
        `  <description>Detailed description of what to do</description>`,
        `  <role>role-name</role>`,
        `  <priority>medium</priority>`,
        `  <depends_on>Title of dependency task</depends_on>`,
        `</task>`,
        '',
        `After your task list, add any questions for the user in <question> tags.`,
        `If you need clarification before proceeding, ask now.`,
      ].join('\n'),
    });

    const response = await this.callLLM();

    // Parse tasks from response
    const parsedTasks = this.parseTaskPlan(response);
    const questions = this.parseQuestions(response);

    // If the LLM has questions, ask the user first
    if (questions.length > 0) {
      await this.askUserQuestions(questions);
    }

    // Create tasks on the board
    const createdTasks = this.createTasksFromPlan(parsedTasks);
    this.log(`Created ${createdTasks.length} tasks`);

    // Notify the team
    this.sendMessage(MessageType.TaskDecomposition, null, {
      taskCount: createdTasks.length,
      tasks: createdTasks.map((t) => ({ id: t.id, title: t.title })),
    });

    // Start monitoring
    this.startMonitoring();
  }

  // ─── Task Decomposition ───────────────────────────────────────────────

  private parseTaskPlan(response: string): ParsedTask[] {
    const tasks: ParsedTask[] = [];
    const taskRegex = /<task>([^]*?)<\/task>/g;
    let match;

    while ((match = taskRegex.exec(response)) !== null) {
      const block = match[1];

      const title = this.extractTag(block, 'title') ?? 'Untitled Task';
      const description =
        this.extractTag(block, 'description') ?? 'No description';
      const role = this.extractTag(block, 'role') ?? 'backend';
      const priority = this.extractTag(block, 'priority') ?? 'medium';
      const dependsOn = this.extractAllTags(block, 'depends_on');

      tasks.push({ title, description, role, priority, dependsOn });
    }

    return tasks;
  }

  private createTasksFromPlan(parsedTasks: ParsedTask[]): Task[] {
    const createdTasks: Task[] = [];
    const titleToId: Map<string, string> = new Map();

    // First pass: create all tasks
    for (const pt of parsedTasks) {
      const task = this.taskBoard.createTask({
        title: pt.title,
        description: pt.description,
        priority: this.parsePriority(pt.priority),
        assigneeId: this.findAgentForRole(pt.role)?.id ?? null,
      });

      // Store preferred role in metadata
      task.metadata['preferredRole'] = pt.role;
      titleToId.set(pt.title.toLowerCase(), task.id);
      createdTasks.push(task);
    }

    // Second pass: wire up dependencies by title reference
    for (let i = 0; i < parsedTasks.length; i++) {
      const pt = parsedTasks[i];
      const task = createdTasks[i];

      for (const depTitle of pt.dependsOn) {
        const depId = titleToId.get(depTitle.toLowerCase());
        if (depId) {
          this.taskBoard.addDependency(task.id, depId);
        }
      }
    }

    return createdTasks;
  }

  private findAgentForRole(role: string): Agent | undefined {
    return this.teamMembers.find((m) => m.roleConfig.role === role);
  }

  // ─── Monitoring Loop ──────────────────────────────────────────────────

  private monitorInterval: ReturnType<typeof setInterval> | null = null;

  private startMonitoring(): void {
    if (this.monitorInterval) return;

    this.monitorInterval = setInterval(() => this.monitorTick(), 5000);
  }

  private stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  private async monitorTick(): Promise<void> {
    const stats = this.taskBoard.getStats();

    // Check for completion
    if (stats.total > 0 && stats.completed === stats.total) {
      this.log('All tasks completed! Starting integration.');
      this.stopMonitoring();
      await this.performIntegration();
      return;
    }

    // Check for all failed/blocked
    if (
      stats.total > 0 &&
      stats.completed + stats.failed + stats.blocked === stats.total
    ) {
      this.log('All tasks ended (some failed/blocked). Reporting to user.');
      this.stopMonitoring();
      await this.reportFinalStatus();
      return;
    }

    // Check for blocked tasks that need intervention
    const blocked = this.taskBoard.getBlockedTasks();
    for (const task of blocked) {
      await this.handleBlockedTask(task);
    }
  }

  // ─── Blocker Resolution ───────────────────────────────────────────────

  private async handleBlockedTask(task: Task): Promise<void> {
    this.log(`Attempting to resolve blocker on: ${task.title}`);

    this.conversationHistory.push({
      role: 'user',
      content: [
        `Task "${task.title}" is BLOCKED.`,
        `Assigned to: ${task.assigneeId}`,
        `Blocked by: ${task.blockedBy.join(', ')}`,
        '',
        `How should we resolve this? Options:`,
        `1. Provide guidance to the blocked agent`,
        `2. Reassign to a different agent`,
        `3. Break into smaller tasks`,
        `4. Ask the user for help`,
        '',
        `Respond with a <directive> tag for the agent, or a <question> tag for the user.`,
      ].join('\n'),
    });

    const response = await this.callLLM();

    const directive = this.extractTag(response, 'directive');
    if (directive && task.assigneeId) {
      this.sendMessage(MessageType.TeamDirective, task.assigneeId, {
        directive,
        taskId: task.id,
      });
      this.sendMessage(MessageType.BlockerResolved, task.assigneeId, {
        taskId: task.id,
      });
      this.taskBoard.updateTask(task.id, { status: TaskStatus.InProgress });
    }

    const question = this.extractTag(response, 'question');
    if (question) {
      await this.askUserQuestions([question]);
    }
  }

  // ─── Integration ──────────────────────────────────────────────────────

  private async performIntegration(): Promise<void> {
    this.setStatus(AgentStatus.Working);
    this.sendMessage(MessageType.IntegrationStart, null, {});

    const completedTasks = this.taskBoard.getTasksByStatus(
      TaskStatus.Completed
    );

    this.conversationHistory.push({
      role: 'user',
      content: [
        `## Integration Phase`,
        '',
        `All tasks are completed. Review the results and check for:`,
        `1. Integration issues between components`,
        `2. Missing connections or imports`,
        `3. Inconsistencies in naming or patterns`,
        `4. Anything that doesn't fit together properly`,
        '',
        `Completed tasks:`,
        ...completedTasks.map(
          (t) =>
            `- ${t.title} (by ${t.assigneeId}): ${t.description.slice(0, 100)}`
        ),
        '',
        `If everything looks good, use <action type="complete">summary</action>.`,
        `If you need to fix something, use file actions to make corrections.`,
      ].join('\n'),
    });

    const response = await this.callLLM();
    const actions = this.parseActions(response);

    for (const action of actions) {
      await this.executeAction(
        action,
        this.taskBoard.createTask({
          title: 'Integration',
          description: 'Team Lead integration pass',
        })
      );
    }

    this.sendMessage(MessageType.IntegrationComplete, null, {});
    await this.reportFinalStatus();
  }

  // ─── User Communication ───────────────────────────────────────────────

  private async askUserQuestions(questions: string[]): Promise<void> {
    for (const question of questions) {
      const answer = await vscode.window.showInputBox({
        prompt: `DevCrew Team Lead asks: ${question}`,
        placeHolder: 'Your answer...',
        ignoreFocusOut: true,
      });

      if (answer) {
        this.conversationHistory.push({
          role: 'user',
          content: `User answered: "${answer}" (in response to: "${question}")`,
        });
      }
    }
  }

  async chatWithUser(userMessage: string): Promise<string> {
    const stats = this.taskBoard.getStats();

    this.conversationHistory.push({
      role: 'user',
      content: [
        `## User Message`,
        userMessage,
        '',
        `## Current Status`,
        `Tasks: ${stats.completed}/${stats.total} completed, ${stats.inProgress} in progress, ${stats.blocked} blocked`,
      ].join('\n'),
    });

    return this.callLLM();
  }

  private async reportFinalStatus(): Promise<void> {
    const stats = this.taskBoard.getStats();
    const summary = [
      `DevCrew task completed.`,
      `Results: ${stats.completed} completed, ${stats.failed} failed, ${stats.blocked} blocked out of ${stats.total} total tasks.`,
    ].join(' ');

    vscode.window.showInformationMessage(summary);
    this.setStatus(AgentStatus.Done);
  }

  // ─── Message Handling ─────────────────────────────────────────────────

  protected handleMessage(message: Message): void {
    switch (message.type) {
      case MessageType.TaskCompleted: {
        const payload = message.payload as { taskId: string; summary: string };
        this.log(
          `Agent ${message.fromAgentId} completed task ${payload.taskId}`
        );
        this.integrationQueue.push(payload.taskId);
        break;
      }

      case MessageType.TaskFailed: {
        const payload = message.payload as { taskId: string; error: string };
        this.log(
          `Agent ${message.fromAgentId} FAILED task ${payload.taskId}: ${payload.error}`
        );
        break;
      }

      case MessageType.BlockerRaised: {
        const payload = message.payload as {
          taskId: string;
          description: string;
        };
        this.log(
          `BLOCKER from ${message.fromAgentId}: ${payload.description}`
        );
        break;
      }

      case MessageType.Question: {
        this.handleTeamQuestion(message);
        break;
      }

      case MessageType.StatusUpdate: {
        const payload = message.payload as { taskId: string; message: string };
        this.log(
          `Status from ${message.fromAgentId}: ${payload.message}`
        );
        break;
      }

      default:
        break;
    }
  }

  private async handleTeamQuestion(message: Message): Promise<void> {
    const payload = message.payload as { question: string };

    this.conversationHistory.push({
      role: 'user',
      content: `Team member ${message.fromAgentId} asks: ${payload.question}`,
    });

    const response = await this.callLLM();

    this.sendMessage(MessageType.Answer, message.fromAgentId, {
      answer: response,
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private async callLLM(): Promise<string> {
    const response = await this.llm.sendMessages(this.conversationHistory);
    this.conversationHistory.push({
      role: 'assistant',
      content: response,
    });
    return response;
  }

  private buildTeamContext(): string {
    return this.teamMembers
      .map(
        (m) =>
          `- **${m.roleConfig.name}** (${m.roleConfig.role}): ${m.roleConfig.description}\n  Capabilities: ${m.roleConfig.capabilities.join(', ')}`
      )
      .join('\n');
  }

  private parseQuestions(response: string): string[] {
    const questions: string[] = [];
    const regex = /<question>([^]*?)<\/question>/g;
    let match;
    while ((match = regex.exec(response)) !== null) {
      questions.push(match[1].trim());
    }
    return questions;
  }

  private extractTag(text: string, tag: string): string | null {
    const regex = new RegExp(`<${tag}>([^]*?)</${tag}>`);
    const match = text.match(regex);
    return match ? match[1].trim() : null;
  }

  private extractAllTags(text: string, tag: string): string[] {
    const results: string[] = [];
    const regex = new RegExp(`<${tag}>([^]*?)</${tag}>`, 'g');
    let match;
    while ((match = regex.exec(text)) !== null) {
      results.push(match[1].trim());
    }
    return results;
  }

  private parsePriority(s: string): TaskPriority {
    switch (s.toLowerCase()) {
      case 'critical':
        return TaskPriority.Critical;
      case 'high':
        return TaskPriority.High;
      case 'low':
        return TaskPriority.Low;
      default:
        return TaskPriority.Medium;
    }
  }

  // ─── Pause / Resume ──────────────────────────────────────────────

  override pause(): void {
    this.stopMonitoring();
    super.pause();
  }

  override resume(): void {
    super.resume();
    // Restart monitoring if there are outstanding tasks
    const stats = this.taskBoard.getStats();
    if (stats.total > stats.completed + stats.failed) {
      this.startMonitoring();
      this.log('Monitoring restarted after resume');
    }
  }

  dispose(): void {
    this.stopMonitoring();
    super.dispose();
  }
}

interface ParsedTask {
  title: string;
  description: string;
  role: string;
  priority: string;
  dependsOn: string[];
}
