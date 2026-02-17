import * as vscode from 'vscode';
import { AgentRoleConfig, LLMService } from '../types';
import { Agent } from './agent';
import { SpecialistAgent } from './specialistAgent';
import { TeamLeadAgent } from './teamLeadAgent';
import { ROLE_DEFINITIONS } from './roles/roleDefinitions';
import { MessageBus } from '../communication/messageBus';
import { FileManager } from '../fileops/fileManager';
import { TaskBoard } from '../orchestration/taskBoard';

/**
 * Dynamic agent registry. At startup only the Team Lead is created.
 * The Team Lead then creates specialist agents on-demand via
 * createAgent() based on what the task requires.
 */
export class AgentRegistry {
  private agents: Map<string, Agent> = new Map();
  private teamLead: TeamLeadAgent | null = null;

  private readonly _onAgentAdded = new vscode.EventEmitter<Agent>();
  readonly onAgentAdded = this._onAgentAdded.event;

  private readonly _onAgentRemoved = new vscode.EventEmitter<Agent>();
  readonly onAgentRemoved = this._onAgentRemoved.event;

  constructor(
    private readonly messageBus: MessageBus,
    private readonly fileManager: FileManager,
    private readonly taskBoard: TaskBoard,
    private readonly llm: LLMService
  ) {}

  /**
   * Bootstrap the team — creates only the Team Lead.
   * Specialist agents are created dynamically by the Team Lead later.
   */
  buildTeam(): void {
    this.disposeAll();

    const leadConfig = ROLE_DEFINITIONS['team-lead'];
    this.teamLead = new TeamLeadAgent(
      leadConfig,
      this.messageBus,
      this.fileManager,
      this.taskBoard,
      this.llm,
      this // pass registry so Team Lead can create/remove agents
    );
    this.agents.set(this.teamLead.id, this.teamLead);
    this.messageBus.registerAlias('team-lead', this.teamLead.id);
  }

  /**
   * Dynamically create a specialist agent with the given role config.
   * The agent is started immediately and registered on the message bus.
   */
  createAgent(roleConfig: AgentRoleConfig): Agent {
    const agent = new SpecialistAgent(
      roleConfig,
      this.messageBus,
      this.fileManager,
      this.llm
    );

    this.agents.set(agent.id, agent);
    this.messageBus.registerAlias(roleConfig.role, agent.id);
    agent.start();

    this._onAgentAdded.fire(agent);
    return agent;
  }

  /**
   * Remove and dispose a specialist agent.
   * Returns true if the agent was found and removed.
   */
  removeAgent(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent || agent === this.teamLead) return false;

    this.messageBus.unregisterAlias(agent.roleConfig.role);
    agent.dispose();
    this.agents.delete(agentId);

    this._onAgentRemoved.fire(agent);
    return true;
  }

  getTeamLead(): TeamLeadAgent | null {
    return this.teamLead;
  }

  getAgent(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  getAllAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  getSpecialists(): Agent[] {
    return this.getAllAgents().filter(
      (a) => a.roleConfig.role !== 'team-lead'
    );
  }

  getAgentByRole(role: string): Agent | undefined {
    return this.getAllAgents().find((a) => a.roleConfig.role === role);
  }

  startAll(): void {
    for (const agent of this.agents.values()) {
      agent.start();
    }
  }

  stopAll(): void {
    for (const agent of this.agents.values()) {
      agent.stop();
    }
  }

  pauseAll(): void {
    for (const agent of this.agents.values()) {
      agent.pause();
    }
  }

  resumeAll(): void {
    for (const agent of this.agents.values()) {
      agent.resume();
    }
  }

  disposeAll(): void {
    for (const agent of this.agents.values()) {
      agent.dispose();
    }
    this.agents.clear();
    this.teamLead = null;
  }

  dispose(): void {
    this.disposeAll();
    this._onAgentAdded.dispose();
    this._onAgentRemoved.dispose();
  }
}
