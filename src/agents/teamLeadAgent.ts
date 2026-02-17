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
import { Agent, AgentAction } from './agent';
import { AgentRegistry } from './registry';
import { MessageBus } from '../communication/messageBus';
import { FileManager } from '../fileops/fileManager';
import { TaskBoard } from '../orchestration/taskBoard';
import { getRoleTemplate, getRoleTemplateSummary } from './roles/roleDefinitions';

/**
 * The Team Lead is the orchestrating agent. It:
 * - Receives user requests and dynamically staffs the team
 * - Decomposes requests into tasks and assigns them to specialists
 * - Monitors progress and resolves blockers
 * - Integrates work from multiple agents
 * - Communicates status back to the user
 */
export class TeamLeadAgent extends Agent {
  private readonly taskBoard: TaskBoard;
  private readonly registry: AgentRegistry;
  private integrationQueue: string[] = [];
  private integrationCompleted = false;

  constructor(
    roleConfig: AgentRoleConfig,
    messageBus: MessageBus,
    fileManager: FileManager,
    taskBoard: TaskBoard,
    llm: LLMService,
    registry: AgentRegistry
  ) {
    super(roleConfig, messageBus, fileManager, llm);
    this.taskBoard = taskBoard;
    this.registry = registry;
  }

  // ─── User-Facing Entry Point ──────────────────────────────────────────

  /**
   * Progress callback for streaming updates during handleUserRequest.
   * Set by the caller (extension.ts) before calling handleUserRequest.
   */
  onProgress: ((message: string) => void) | null = null;

  /**
   * Completion callback invoked when all tasks are done (or failed/blocked).
   * Set by extension.ts to open the SummaryPanel.
   */
  onComplete: (() => void) | null = null;

  /**
   * Main entry point: user gives a high-level request, Team Lead
   * dynamically staffs the team and decomposes work into tasks.
   *
   * Split into two streaming LLM calls:
   *   1. Staffing — analyze request and create agents
   *   2. Decomposition — break work into tasks assigned to those agents
   */
  async handleUserRequest(request: string): Promise<void> {
    const { mode, boardSummary } = this.prepareForRequest();
    this.setStatus(AgentStatus.Working);
    this.log(`Received user request: ${request}`);

    // ── Phase 1: Staffing (+ Triage when active work exists) ─────────
    this.reportProgress(mode === 'triage'
      ? 'Phase 1/2: Analyzing request, triaging active work, and staffing team...'
      : 'Phase 1/2: Analyzing request and staffing team...');

    const roleTemplateSummary = getRoleTemplateSummary();
    const existingTeamContext = this.buildExistingTeamContext();

    const staffingPromptParts = [
      `## User Request`,
      request,
      '',
      existingTeamContext,
      '',
    ];

    // Include board context and cancel_task instructions in triage mode
    if (mode === 'triage' && boardSummary) {
      staffingPromptParts.push(
        `## Active Task Board`,
        `The following tasks are still on the board from the previous request.`,
        `Review them and decide which to keep and which to cancel.`,
        boardSummary,
        '',
        `To cancel a task that is no longer needed, output a <cancel_task> block:`,
        `<cancel_task>task-id-or-title</cancel_task>`,
        '',
        `Tasks you don't cancel will continue running.`,
        '',
      );
    }

    staffingPromptParts.push(
      `## Your Job: Staffing`,
      `Analyze this request and decide what team members you need.`,
      '',
      `Available role templates (you can use as-is, customize, or create new ones):`,
      roleTemplateSummary,
      '',
      `For each agent you need, output an <agent> block:`,
      `<agent>`,
      `  <role>unique-role-id</role>`,
      `  <name>Display Name</name>`,
      `  <description>What this agent does</description>`,
      `  <prompt>Detailed system prompt for this specialist...</prompt>`,
      `  <capabilities>comma, separated, capabilities</capabilities>`,
      `</agent>`,
      '',
      `For built-in role templates, you only need to provide the <role> tag — the rest will be filled from the template. Add other tags only to override template defaults.`,
      '',
      `To remove an existing agent you no longer need, output a <remove_agent> block:`,
      `<remove_agent>role-id</remove_agent>`,
      '',
      `To keep an existing agent, simply don't mention them — they'll stay on the team.`,
      '',
      `After your agent blocks, include any questions for the user in <question> tags.`,
    );

    this.conversationHistory.push({
      role: 'user',
      content: staffingPromptParts.join('\n'),
    });

    let lastReportedAgentCount = 0;
    const staffingResponse = await this.callLLMStreaming(
      (chunk, accumulated) => {
        // Count agents parsed so far for progress — only report when count changes
        const agentCount = (accumulated.match(/<\/agent>/g) || []).length;
        if (agentCount > 0 && agentCount !== lastReportedAgentCount) {
          lastReportedAgentCount = agentCount;
          this.reportProgress(`Phase 1/2: Identified ${agentCount} team member${agentCount > 1 ? 's' : ''}...`);
        }
      }
    );

    // Execute triage decisions (cancel tasks, abort agents)
    if (mode === 'triage') {
      this.executeCancellations(staffingResponse);
    }

    // Process agent removals first
    const removals = this.parseRemoveAgentBlocks(staffingResponse);
    for (const roleId of removals) {
      const agent = this.registry.getAgentByRole(roleId);
      if (agent) {
        this.registry.removeAgent(agent.id);
        this.log(`Removed agent: ${agent.roleConfig.name} (${roleId})`);
        this.sendMessage(MessageType.AgentRemoved, null, {
          agentId: agent.id,
          role: roleId,
          name: agent.roleConfig.name,
        });
      }
    }

    // Parse and create agents (skip if role already exists)
    const parsedAgents = this.parseAgentBlocks(staffingResponse);
    let createdCount = 0;
    for (const agentDef of parsedAgents) {
      const existing = this.registry.getAgentByRole(agentDef.role);
      if (existing) {
        this.log(`Skipping agent creation — role "${agentDef.role}" already exists (${existing.id})`);
        continue;
      }

      const roleConfig = this.buildRoleConfig(agentDef);
      const agent = this.registry.createAgent(roleConfig);
      createdCount++;
      this.log(`Created agent: ${agent.roleConfig.name} (${agent.roleConfig.role})`);

      // Notify activity feed
      this.sendMessage(MessageType.AgentCreated, null, {
        agentId: agent.id,
        role: agent.roleConfig.role,
        name: agent.roleConfig.name,
      });
    }

    const totalSpecialists = this.registry.getSpecialists().length;
    const keptCount = totalSpecialists - createdCount;
    const staffMsg = keptCount > 0
      ? `Team: ${totalSpecialists} agents (${keptCount} kept, ${createdCount} new).`
      : `Staffed ${createdCount} agent${createdCount !== 1 ? 's' : ''}.`;
    this.reportProgress(`${staffMsg} Phase 2/2: Decomposing tasks...`);

    // Handle any questions from staffing phase
    const staffingQuestions = this.parseQuestions(staffingResponse);
    if (staffingQuestions.length > 0) {
      await this.askUserQuestions(staffingQuestions);
    }

    // ── Phase 2: Task Decomposition ────────────────────────────────────
    const teamContext = this.buildTeamContext();
    const survivingContext = this.buildSurvivingTaskContext();

    const decompositionParts = [
      `## Team Created`,
      `You now have these team members:`,
      teamContext,
      '',
    ];

    if (survivingContext) {
      decompositionParts.push(
        `## Surviving Tasks`,
        `These tasks are still on the board. New tasks will be ADDED alongside them.`,
        `You can reference surviving task titles in <depends_on> tags.`,
        survivingContext,
        '',
      );
    }

    decompositionParts.push(
      `## Your Job: Task Decomposition`,
      `Decompose the following request into concrete tasks for your team:`,
      `> ${request}`,
      '',
      `IMPORTANT — phasing rules:`,
      `1. ALWAYS start with an architect task that defines the system design, interfaces, data models, and file structure. This task must produce concrete artifacts (type definitions, API contracts, schemas) — not just an assessment.`,
      `2. ALL implementation tasks (frontend, backend, etc.) MUST depend on the architect's design task so they build against the defined contracts.`,
      `3. Testing and review tasks MUST depend on the implementation tasks they verify.`,
      `4. In each task description, explicitly reference which interface/contract files from the architect task the agent should read and conform to.`,
      '',
      `For each task, specify:`,
      `- A clear title and description (include which files to read and which to create)`,
      `- Which role should handle it (must match a role from the team above)`,
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
      `Add any remaining questions in <question> tags.`,
    );

    this.conversationHistory.push({
      role: 'user',
      content: decompositionParts.join('\n'),
    });

    let lastReportedTaskCount = 0;
    const decompositionResponse = await this.callLLMStreaming(
      (chunk, accumulated) => {
        const taskCount = (accumulated.match(/<\/task>/g) || []).length;
        if (taskCount > 0 && taskCount !== lastReportedTaskCount) {
          lastReportedTaskCount = taskCount;
          this.reportProgress(`Phase 2/2: Planned ${taskCount} task${taskCount > 1 ? 's' : ''} so far...`);
        }
      }
    );

    // Parse tasks and questions
    const parsedTasks = this.parseTaskPlan(decompositionResponse);
    const questions = this.parseQuestions(decompositionResponse);

    if (questions.length > 0) {
      await this.askUserQuestions(questions);
    }

    // Create tasks on the board (added alongside surviving tasks)
    const createdTasks = this.createTasksFromPlan(parsedTasks);
    this.log(`Created ${createdTasks.length} tasks`);

    // Notify the team
    this.sendMessage(MessageType.TaskDecomposition, null, {
      taskCount: createdTasks.length,
      tasks: createdTasks.map((t) => ({ id: t.id, title: t.title })),
    });

    this.reportProgress(`Created ${createdTasks.length} tasks. Team is working...`);

    // Start monitoring (only if there are active tasks to monitor)
    const activeStats = this.taskBoard.getStats();
    const activeTasks = activeStats.total - activeStats.cancelled - activeStats.completed;
    if (activeTasks > 0) {
      this.startMonitoring();
    } else {
      this.log('No active tasks — skipping monitoring.');
    }
  }

  /**
   * Assess board state and prepare for a new request. Instead of always
   * nuking the board, returns 'triage' mode when active work exists so
   * the Team Lead can surgically cancel/keep tasks.
   */
  private prepareForRequest(): { mode: 'fresh' | 'triage'; boardSummary: string } {
    this.stopMonitoring();
    this.integrationCompleted = false;
    this.integrationQueue = [];

    const stats = this.taskBoard.getStats();
    const hasActiveWork = stats.inProgress > 0 || stats.pending > 0 || stats.blocked > 0;

    if (!hasActiveWork) {
      // All done (or empty board) — clear and start fresh
      this.taskBoard.clear();
      this.conversationHistory.push({
        role: 'user',
        content: '--- NEW ROUND ---\nThe previous request is complete. A new user request follows.',
      });
      return { mode: 'fresh', boardSummary: '' };
    }

    // Active work exists — build board summary for triage
    this.conversationHistory.push({
      role: 'user',
      content: '--- NEW REQUEST ---\nA new user request follows. Some tasks are still active.',
    });
    return { mode: 'triage', boardSummary: this.buildBoardContext() };
  }

  private buildExistingTeamContext(): string {
    const specialists = this.registry.getSpecialists();
    if (specialists.length === 0) {
      return `## Existing Team\nNo specialist agents — create all you need.`;
    }

    const lines = specialists.map((a) => {
      const status = a.getState().status;
      return `- **${a.roleConfig.name}** (role: \`${a.roleConfig.role}\`): ${a.roleConfig.description} [status: ${status}]`;
    });

    return [
      `## Existing Team`,
      `You already have these specialist agents:`,
      ...lines,
      '',
      `You can:`,
      `- **Keep** an agent (don't mention them — they stay)`,
      `- **Remove** an agent you no longer need: \`<remove_agent>role-id</remove_agent>\``,
      `- **Replace** an agent: remove then add a new one`,
      `- **Add** new agents with \`<agent>\` blocks as usual`,
    ].join('\n');
  }

  private buildBoardContext(): string {
    const tasks = this.taskBoard.getAllTasks();
    const groups: Record<string, Task[]> = {
      'In Progress': [],
      'Pending': [],
      'Blocked': [],
      'Completed': [],
    };

    for (const task of tasks) {
      switch (task.status) {
        case TaskStatus.InProgress:
        case TaskStatus.Assigned:
          groups['In Progress'].push(task);
          break;
        case TaskStatus.Pending:
          groups['Pending'].push(task);
          break;
        case TaskStatus.Blocked:
          groups['Blocked'].push(task);
          break;
        case TaskStatus.Completed:
          groups['Completed'].push(task);
          break;
      }
    }

    const lines: string[] = [];
    for (const [status, statusTasks] of Object.entries(groups)) {
      if (statusTasks.length === 0) continue;
      lines.push(`### ${status}`);
      for (const t of statusTasks) {
        const assignee = t.assigneeId
          ? this.registry.getAgent(t.assigneeId)?.roleConfig.name ?? t.assigneeId
          : 'unassigned';
        lines.push(`- **${t.title}** (id: \`${t.id}\`, role: ${assignee}): ${t.description.slice(0, 100)}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private parseCancelTaskBlocks(response: string): string[] {
    const ids: string[] = [];
    const regex = /<cancel_task>([^]*?)<\/cancel_task>/g;
    let match;
    while ((match = regex.exec(response)) !== null) {
      const ref = match[1].trim();
      if (ref) ids.push(ref);
    }
    return ids;
  }

  private executeCancellations(response: string): void {
    const refs = this.parseCancelTaskBlocks(response);
    if (refs.length === 0) return;

    const allTasks = this.taskBoard.getAllTasks();

    for (const ref of refs) {
      // Resolve by ID first, fall back to title match
      let task = this.taskBoard.getTask(ref);
      if (!task) {
        task = allTasks.find(t => t.title.toLowerCase() === ref.toLowerCase());
      }
      if (!task) {
        this.log(`Cancel target not found: "${ref}"`);
        continue;
      }

      const result = this.taskBoard.cancelTask(task.id);
      if (!result) {
        this.log(`Could not cancel task "${task.title}" (status: ${task.status})`);
        continue;
      }

      this.log(`Cancelled task: ${task.title}`);

      // If the assigned agent is working on this task, abort it
      if (task.assigneeId) {
        const agent = this.registry.getAgent(task.assigneeId);
        if (agent && agent.getState().status === AgentStatus.Working && agent.getState().currentTaskId === task.id) {
          agent.cancelCurrentTask();
          this.log(`Aborted agent ${agent.roleConfig.name} for cancelled task`);
        }
      }

      this.sendMessage(MessageType.StatusUpdate, null, {
        message: `Task cancelled: ${task.title}`,
        taskId: task.id,
      });
    }
  }

  private buildSurvivingTaskContext(): string {
    const tasks = this.taskBoard.getAllTasks();
    const active: Task[] = [];
    const completed: Task[] = [];

    for (const task of tasks) {
      if (task.status === TaskStatus.Cancelled) continue;
      if (task.status === TaskStatus.Completed) {
        completed.push(task);
      } else {
        active.push(task);
      }
    }

    if (active.length === 0 && completed.length === 0) return '';

    const lines: string[] = [];
    if (active.length > 0) {
      lines.push('### Active Tasks');
      for (const t of active) {
        lines.push(`- **${t.title}** (id: \`${t.id}\`, status: ${t.status})`);
      }
      lines.push('');
    }
    if (completed.length > 0) {
      lines.push('### Completed Tasks (for dependency context)');
      for (const t of completed) {
        lines.push(`- **${t.title}** (id: \`${t.id}\`)`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private parseRemoveAgentBlocks(response: string): string[] {
    const roles: string[] = [];
    const regex = /<remove_agent>([^]*?)<\/remove_agent>/g;
    let match;
    while ((match = regex.exec(response)) !== null) {
      const role = match[1].trim();
      if (role) roles.push(role);
    }
    return roles;
  }

  private reportProgress(message: string): void {
    this.onProgress?.(message);
    this.sendMessage(MessageType.StatusUpdate, null, {
      message,
      phase: 'planning',
    });
  }

  // ─── Agent Staffing ─────────────────────────────────────────────────

  private parseAgentBlocks(response: string): ParsedAgent[] {
    const agents: ParsedAgent[] = [];
    const agentRegex = /<agent>([^]*?)<\/agent>/g;
    let match;

    while ((match = agentRegex.exec(response)) !== null) {
      const block = match[1];

      const role = this.extractTag(block, 'role');
      if (!role) continue;

      agents.push({
        role,
        name: this.extractTag(block, 'name'),
        description: this.extractTag(block, 'description'),
        prompt: this.extractTag(block, 'prompt'),
        capabilities: this.extractTag(block, 'capabilities'),
      });
    }

    return agents;
  }

  private buildRoleConfig(parsed: ParsedAgent): AgentRoleConfig {
    const template = getRoleTemplate(parsed.role);

    if (template) {
      // Use template as base, override with any provided customizations
      return {
        role: parsed.role,
        name: parsed.name ?? template.name,
        description: parsed.description ?? template.description,
        systemPrompt: parsed.prompt ?? template.systemPrompt,
        capabilities: parsed.capabilities
          ? parsed.capabilities.split(',').map((c) => c.trim()).filter(Boolean)
          : template.capabilities,
        icon: template.icon,
      };
    }

    // Fully custom role — no template
    return {
      role: parsed.role,
      name: parsed.name ?? parsed.role,
      description: parsed.description ?? '',
      systemPrompt: parsed.prompt ?? '',
      capabilities: parsed.capabilities
        ? parsed.capabilities.split(',').map((c) => c.trim()).filter(Boolean)
        : [],
      icon: '$(symbol-misc)',
    };
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

    // Seed with ALL existing tasks on the board so new tasks can
    // reference surviving tasks by title in <depends_on>
    for (const existing of this.taskBoard.getAllTasks()) {
      titleToId.set(existing.title.toLowerCase(), existing.id);
    }

    // Single pass: create each task with its resolved dependsOn array.
    // Dependencies on earlier tasks are resolved immediately; forward
    // references (dependency declared before the depended-on task) are
    // collected and patched silently after all tasks exist.
    const forwardRefs: Array<{ task: Task; depTitle: string }> = [];

    for (const pt of parsedTasks) {
      const agent = this.findAgentForRole(pt.role);

      // Resolve dependencies that already exist
      const resolvedDeps: string[] = [];
      for (const depTitle of pt.dependsOn) {
        const depId = titleToId.get(depTitle.toLowerCase());
        if (depId) {
          resolvedDeps.push(depId);
        }
        // else: forward reference — will patch after all tasks are created
      }

      const task = this.taskBoard.createTask({
        title: pt.title,
        description: pt.description,
        priority: this.parsePriority(pt.priority),
        assigneeId: agent?.id ?? null,
        dependsOn: resolvedDeps,
      });

      titleToId.set(pt.title.toLowerCase(), task.id);
      createdTasks.push(task);

      // Track any forward references for silent fix-up
      for (const depTitle of pt.dependsOn) {
        if (!titleToId.has(depTitle.toLowerCase()) || !resolvedDeps.includes(titleToId.get(depTitle.toLowerCase())!)) {
          // Only track titles that weren't already resolved
          if (!titleToId.has(depTitle.toLowerCase())) {
            forwardRefs.push({ task, depTitle });
          }
        }
      }
    }

    // Silent fix-up for forward references: push directly to task.dependsOn
    // without calling addDependency() to avoid firing events mid-wiring
    for (const { task, depTitle } of forwardRefs) {
      const depId = titleToId.get(depTitle.toLowerCase());
      if (depId && !task.dependsOn.includes(depId)) {
        task.dependsOn.push(depId);
      }
    }

    return createdTasks;
  }

  private findAgentForRole(role: string): Agent | undefined {
    return this.registry.getAgentByRole(role);
  }

  // ─── Mid-Run Agent Management ──────────────────────────────────────

  protected override async executeAction(action: AgentAction, task: Task): Promise<string> {
    if (action.type === 'create_agent') {
      return this.handleCreateAgent(action);
    }
    if (action.type === 'remove_agent') {
      return this.handleRemoveAgent(action);
    }
    return super.executeAction(action, task);
  }

  private handleCreateAgent(action: {
    role: string;
    name: string;
    description: string;
    prompt: string;
    capabilities: string[];
  }): string {
    const existing = this.registry.getAgentByRole(action.role);
    if (existing) {
      return `Agent with role "${action.role}" already exists (${existing.id}).`;
    }

    const roleConfig = this.buildRoleConfig({
      role: action.role,
      name: action.name || null,
      description: action.description || null,
      prompt: action.prompt || null,
      capabilities: action.capabilities?.join(', ') || null,
    });

    const agent = this.registry.createAgent(roleConfig);
    this.log(`Created agent mid-run: ${agent.roleConfig.name} (${agent.roleConfig.role})`);
    return `Agent created: ${agent.roleConfig.name} (${agent.roleConfig.role}, id=${agent.id})`;
  }

  private handleRemoveAgent(action: { role: string }): string {
    const agent = this.registry.getAgentByRole(action.role);
    if (!agent) {
      return `No agent found with role "${action.role}".`;
    }

    const removed = this.registry.removeAgent(agent.id);
    if (removed) {
      this.log(`Removed agent: ${agent.roleConfig.name} (${action.role})`);
      return `Agent removed: ${agent.roleConfig.name} (${action.role})`;
    }
    return `Could not remove agent with role "${action.role}".`;
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
    const effectiveTotal = stats.total - stats.cancelled;

    // Check for completion
    if (effectiveTotal > 0 && stats.completed === effectiveTotal) {
      if (this.integrationCompleted) {
        this.log('All tasks completed and integration already done. Stopping.');
        this.stopMonitoring();
        return;
      }
      this.log('All tasks completed! Starting integration.');
      this.stopMonitoring();
      await this.performIntegration();
      return;
    }

    // Check for all failed/blocked
    if (
      effectiveTotal > 0 &&
      stats.completed + stats.failed + stats.blocked === effectiveTotal
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
        `5. Create a new specialist agent to help (use <action type="create_agent">)`,
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
            `- ${t.title} (by ${t.assigneeId}):\n  Description: ${t.description.slice(0, 100)}\n  Result: ${(t.metadata['completionSummary'] as string)?.slice(0, 500) ?? 'No summary'}`
        ),
        '',
        `If everything looks good, use <action type="complete">summary</action>.`,
        `If you need to fix something, use file actions to make corrections.`,
      ].join('\n'),
    });

    const response = await this.callLLM();
    const actions = this.parseActions(response);

    // Use a local task object for integration actions — do NOT create tasks
    // on the board, as the scheduler would dispatch them to specialists and
    // they'd pile up indefinitely on pause/resume cycles.
    const integrationTask: Task = {
      id: `integration-${Date.now()}`,
      title: 'Integration',
      description: 'Team Lead integration pass',
      status: TaskStatus.InProgress,
      priority: TaskPriority.Critical,
      assigneeId: this.id,
      dependsOn: [],
      blockedBy: [],
      subtasks: [],
      parentTaskId: null,
      files: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
      metadata: {},
    };

    for (const action of actions) {
      await this.executeAction(action, integrationTask);
    }

    this.integrationCompleted = true;
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
    this.setStatus(AgentStatus.Done);

    if (this.onComplete) {
      this.onComplete();
    } else {
      // Fallback: show a simple notification if no callback is wired
      const stats = this.taskBoard.getStats();
      const summary = [
        `DevCrew task completed.`,
        `Results: ${stats.completed} completed, ${stats.failed} failed, ${stats.blocked} blocked out of ${stats.total} total tasks.`,
      ].join(' ');
      vscode.window.showInformationMessage(summary);
    }
  }

  // ─── Message Handling ─────────────────────────────────────────────────

  protected handleMessage(message: Message): void {
    switch (message.type) {
      case MessageType.TaskCompleted: {
        const payload = message.payload as {
          taskId: string;
          summary: string;
          filesWritten?: string[];
        };
        this.log(
          `Agent ${message.fromAgentId} completed task ${payload.taskId}`
        );
        // Store summary and file provenance on the task for downstream dependencies
        const completedTask = this.taskBoard.getTask(payload.taskId);
        if (completedTask) {
          if (payload.summary) {
            completedTask.metadata['completionSummary'] =
              typeof payload.summary === 'string'
                ? payload.summary.slice(0, 2000)
                : String(payload.summary).slice(0, 2000);
          }
          if (payload.filesWritten?.length) {
            completedTask.metadata['filesWritten'] = payload.filesWritten;
          }
        }
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
        // Handle blocker immediately instead of waiting for monitor tick
        const blockedTask = this.taskBoard.getTask(payload.taskId);
        if (blockedTask) {
          this.handleBlockedTask(blockedTask).catch((err) => {
            this.log(`Error handling blocker: ${err instanceof Error ? err.message : err}`);
          });
        }
        break;
      }

      case MessageType.Question: {
        const qPayload = message.payload as { questionId?: string; question: string };
        this.log(
          `Question from ${message.fromAgentId}: ${qPayload.question}`
        );
        this.handleTeamQuestion(message).catch((err) => {
          this.log(`Error handling question: ${err instanceof Error ? err.message : err}`);
        });
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
    const payload = message.payload as { questionId?: string; question: string };

    this.conversationHistory.push({
      role: 'user',
      content: `Team member ${message.fromAgentId} asks: ${payload.question}`,
    });

    const response = await this.callLLM();

    this.sendMessage(MessageType.Answer, message.fromAgentId, {
      questionId: payload.questionId,
      answer: response,
    });
    this.log(`Answered ${message.fromAgentId}: ${response.slice(0, 200)}`);
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

  private async callLLMStreaming(
    onChunk?: (chunk: string, accumulated: string) => void
  ): Promise<string> {
    const response = await this.llm.streamWithProgress(
      this.conversationHistory,
      onChunk ?? (() => {}),
    );
    this.conversationHistory.push({
      role: 'assistant',
      content: response,
    });
    return response;
  }

  private buildTeamContext(): string {
    return this.registry
      .getSpecialists()
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

interface ParsedAgent {
  role: string;
  name: string | null;
  description: string | null;
  prompt: string | null;
  capabilities: string | null;
}

interface ParsedTask {
  title: string;
  description: string;
  role: string;
  priority: string;
  dependsOn: string[];
}
