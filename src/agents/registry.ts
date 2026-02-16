import { AgentRole, LLMService } from '../types';
import { Agent } from './agent';
import { SpecialistAgent } from './specialistAgent';
import { TeamLeadAgent } from './teamLeadAgent';
import { ROLE_DEFINITIONS } from './roles/roleDefinitions';
import { MessageBus } from '../communication/messageBus';
import { FileManager } from '../fileops/fileManager';
import { TaskBoard } from '../orchestration/taskBoard';

/**
 * Creates and manages agent instances based on the configured team composition.
 */
export class AgentRegistry {
  private agents: Map<string, Agent> = new Map();
  private teamLead: TeamLeadAgent | null = null;

  constructor(
    private readonly messageBus: MessageBus,
    private readonly fileManager: FileManager,
    private readonly taskBoard: TaskBoard,
    private readonly llm: LLMService
  ) {}

  /**
   * Build the team from a list of roles. Team Lead is always created.
   */
  buildTeam(roles: AgentRole[]): Map<string, Agent> {
    this.disposeAll();

    // Always create the Team Lead
    const leadConfig = ROLE_DEFINITIONS['team-lead'];
    this.teamLead = new TeamLeadAgent(
      leadConfig,
      this.messageBus,
      this.fileManager,
      this.taskBoard,
      this.llm
    );
    this.agents.set(this.teamLead.id, this.teamLead);
    this.messageBus.registerAlias('team-lead', this.teamLead.id);

    // Create specialist agents for each configured role
    for (const role of roles) {
      if (role === 'team-lead') continue; // Already created

      const roleConfig = ROLE_DEFINITIONS[role];
      if (!roleConfig) {
        continue;
      }

      const agent = new SpecialistAgent(
        roleConfig,
        this.messageBus,
        this.fileManager,
        this.llm
      );
      this.agents.set(agent.id, agent);
      this.messageBus.registerAlias(role, agent.id);
    }

    // Give the Team Lead knowledge of its team
    this.teamLead.setTeamMembers(this.getSpecialists());

    return this.agents;
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

  getAgentByRole(role: AgentRole): Agent | undefined {
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
}
