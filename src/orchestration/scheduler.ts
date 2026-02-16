import * as vscode from 'vscode';
import { AgentStatus, Task, TaskStatus } from '../types';
import { Agent } from '../agents/agent';
import { AgentRegistry } from '../agents/registry';
import { TaskBoard } from './taskBoard';

/**
 * The scheduler pulls ready tasks from the TaskBoard and assigns them
 * to idle agents, respecting dependency order and parallelism limits.
 * It runs as a polling loop while the team is active.
 */
export class Scheduler {
  private isRunning = false;
  private isTicking = false;
  private schedulerInterval: ReturnType<typeof setInterval> | null = null;
  private activeExecutions: Map<string, Promise<void>> = new Map();
  private outputChannel: vscode.OutputChannel;

  constructor(
    private readonly agentRegistry: AgentRegistry,
    private readonly taskBoard: TaskBoard,
    private readonly maxParallel: number
  ) {
    this.outputChannel = vscode.window.createOutputChannel(
      'DevCrew: Scheduler'
    );
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.log('Scheduler started');

    // Poll for ready tasks every 2 seconds
    this.schedulerInterval = setInterval(() => this.tick(), 2000);

    // Also react immediately when tasks change
    this.taskBoard.onTaskChange(() => {
      if (this.isRunning) this.tick();
    });
  }

  stop(): void {
    this.isRunning = false;
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }
    this.log('Scheduler stopped');
  }

  private tick(): void {
    // Guard against reentrant calls from onTaskChange during dispatch
    if (this.isTicking) return;
    this.isTicking = true;

    try {
      this.tickInner();
    } finally {
      this.isTicking = false;
    }
  }

  private tickInner(): void {
    // Don't exceed parallelism limit
    if (this.activeExecutions.size >= this.maxParallel) {
      return;
    }

    // Find ready tasks (dependencies met, not assigned)
    const readyTasks = this.taskBoard.getReadyTasks();
    if (readyTasks.length === 0) return;

    // Sort by priority (lower number = higher priority)
    readyTasks.sort((a, b) => a.priority - b.priority);

    // Find idle agents
    const idleAgents = this.agentRegistry
      .getSpecialists()
      .filter((a) => a.getState().status === AgentStatus.Idle);

    // Match tasks to agents
    for (const task of readyTasks) {
      if (this.activeExecutions.size >= this.maxParallel) break;
      if (idleAgents.length === 0) break;

      const agent = this.findBestAgent(task, idleAgents);
      if (!agent) continue;

      // Remove from idle pool
      const idx = idleAgents.indexOf(agent);
      idleAgents.splice(idx, 1);

      // Assign and execute
      this.dispatch(agent, task);
    }
  } // end tickInner

  private findBestAgent(task: Task, idleAgents: Agent[]): Agent | null {
    if (idleAgents.length === 0) return null;

    // If task is already assigned to a specific agent, use that one
    if (task.assigneeId) {
      const assigned = idleAgents.find((a) => a.id === task.assigneeId);
      if (assigned) return assigned;
    }

    // Try to match by role affinity based on task metadata
    const preferredRole = task.metadata['preferredRole'] as string | undefined;
    if (preferredRole) {
      const roleMatch = idleAgents.find(
        (a) => a.roleConfig.role === preferredRole
      );
      if (roleMatch) return roleMatch;
    }

    // Heuristic: match keywords in task title/description to agent capabilities
    const taskText = `${task.title} ${task.description}`.toLowerCase();
    let bestAgent: Agent | null = null;
    let bestScore = -1;

    for (const agent of idleAgents) {
      let score = 0;
      for (const capability of agent.roleConfig.capabilities) {
        const keywords = capability.toLowerCase().split(/\s+/);
        for (const kw of keywords) {
          if (taskText.includes(kw)) {
            score++;
          }
        }
      }

      // Bonus for fewer completed tasks (load balancing)
      const completedCount = agent.getState().completedTaskIds.length;
      score -= completedCount * 0.1;

      if (score > bestScore) {
        bestScore = score;
        bestAgent = agent;
      }
    }

    return bestAgent ?? idleAgents[0];
  }

  private dispatch(agent: Agent, task: Task): void {
    this.log(`Dispatching "${task.title}" to ${agent.roleConfig.name}`);

    this.taskBoard.assignTask(task.id, agent.id);
    this.taskBoard.startTask(task.id);

    const execution = agent
      .executeTask(task)
      .then(() => {
        this.taskBoard.completeTask(task.id);
        this.log(`Task "${task.title}" completed by ${agent.roleConfig.name}`);
      })
      .catch((err) => {
        this.taskBoard.failTask(task.id);
        this.log(
          `Task "${task.title}" failed: ${err instanceof Error ? err.message : err}`
        );
      })
      .finally(() => {
        this.activeExecutions.delete(task.id);
      });

    this.activeExecutions.set(task.id, execution);
  }

  getActiveCount(): number {
    return this.activeExecutions.size;
  }

  private log(message: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    this.outputChannel.appendLine(`[${ts}] ${message}`);
  }

  dispose(): void {
    this.stop();
    this.outputChannel.dispose();
  }
}
