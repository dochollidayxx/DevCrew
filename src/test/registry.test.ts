import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentRegistry } from '../agents/registry';
import { MessageBus } from '../communication/messageBus';
import { FileManager } from '../fileops/fileManager';
import { TaskBoard } from '../orchestration/taskBoard';
import { ROLE_DEFINITIONS } from '../agents/roles/roleDefinitions';
import { LLMService } from '../types';

function createMockLLM(): LLMService {
  const sendMessages = vi.fn().mockResolvedValue('mock response');
  return {
    modelName: 'test-model',
    sendMessages,
    streamMessages: vi.fn(),
    streamWithProgress: vi.fn().mockImplementation(async (messages: unknown[], onChunk?: (chunk: string, accumulated: string) => void) => {
      const result = await sendMessages(messages);
      onChunk?.(result, result);
      return result;
    }),
  };
}

describe('AgentRegistry', () => {
  let messageBus: MessageBus;
  let fileManager: FileManager;
  let taskBoard: TaskBoard;
  let registry: AgentRegistry;

  beforeEach(() => {
    messageBus = new MessageBus();
    fileManager = new FileManager(false, false);
    taskBoard = new TaskBoard();
    registry = new AgentRegistry(
      messageBus,
      fileManager,
      taskBoard,
      createMockLLM()
    );
  });

  afterEach(() => {
    registry.dispose();
    messageBus.dispose();
    fileManager.dispose();
    taskBoard.dispose();
  });

  // ─── buildTeam (Team Lead only) ─────────────────────────────────────

  it('buildTeam creates only the Team Lead', () => {
    registry.buildTeam();

    expect(registry.getAllAgents()).toHaveLength(1);
    expect(registry.getTeamLead()).toBeDefined();
    expect(registry.getTeamLead()?.roleConfig.role).toBe('team-lead');
  });

  it('buildTeam registers Team Lead alias', () => {
    const registerAliasSpy = vi.spyOn(messageBus, 'registerAlias');
    registry.buildTeam();

    expect(registerAliasSpy).toHaveBeenCalledTimes(1);
    expect(registerAliasSpy).toHaveBeenCalledWith(
      'team-lead',
      registry.getTeamLead()!.id
    );
  });

  it('getSpecialists returns empty array after buildTeam', () => {
    registry.buildTeam();
    expect(registry.getSpecialists()).toHaveLength(0);
  });

  it('buildTeam disposes previous team before building new one', () => {
    registry.buildTeam();
    const firstLead = registry.getTeamLead();

    registry.buildTeam();
    const secondLead = registry.getTeamLead();

    expect(secondLead).not.toBe(firstLead);
    expect(registry.getAllAgents()).toHaveLength(1);
  });

  // ─── Dynamic createAgent ──────────────────────────────────────────

  describe('createAgent', () => {
    beforeEach(() => {
      registry.buildTeam();
    });

    it('creates a specialist agent from a role config', () => {
      const roleConfig = ROLE_DEFINITIONS['frontend'];
      const agent = registry.createAgent(roleConfig);

      expect(agent).toBeDefined();
      expect(agent.roleConfig.role).toBe('frontend');
      expect(registry.getAllAgents()).toHaveLength(2); // lead + specialist
      expect(registry.getSpecialists()).toHaveLength(1);
    });

    it('registers alias for the new agent', () => {
      const registerAliasSpy = vi.spyOn(messageBus, 'registerAlias');
      registry.createAgent(ROLE_DEFINITIONS['backend']);

      const backendCall = registerAliasSpy.mock.calls.find(
        (call) => call[0] === 'backend'
      );
      expect(backendCall).toBeDefined();
    });

    it('starts the agent immediately', () => {
      const agent = registry.createAgent(ROLE_DEFINITIONS['frontend']);
      // Agent should be started — it has a message subscription
      // The best way to verify is that it doesn't throw when we stop it
      expect(() => agent.stop()).not.toThrow();
    });

    it('fires onAgentAdded event', () => {
      const listener = vi.fn();
      registry.onAgentAdded(listener);

      const agent = registry.createAgent(ROLE_DEFINITIONS['tester']);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(agent);
    });

    it('can create multiple agents', () => {
      registry.createAgent(ROLE_DEFINITIONS['frontend']);
      registry.createAgent(ROLE_DEFINITIONS['backend']);
      registry.createAgent(ROLE_DEFINITIONS['tester']);

      expect(registry.getSpecialists()).toHaveLength(3);
      expect(registry.getAllAgents()).toHaveLength(4);
    });

    it('creates custom role agents', () => {
      const customRole = {
        role: 'data-engineer',
        name: 'Data Engineer',
        description: 'Handles data pipelines',
        systemPrompt: 'You are a data engineer...',
        capabilities: ['ETL', 'SQL', 'data modeling'],
        icon: '$(database)',
      };

      const agent = registry.createAgent(customRole);
      expect(agent.roleConfig.role).toBe('data-engineer');
      expect(registry.getAgentByRole('data-engineer')).toBe(agent);
    });
  });

  // ─── Dynamic removeAgent ──────────────────────────────────────────

  describe('removeAgent', () => {
    beforeEach(() => {
      registry.buildTeam();
    });

    it('removes a specialist agent', () => {
      const agent = registry.createAgent(ROLE_DEFINITIONS['frontend']);
      expect(registry.getSpecialists()).toHaveLength(1);

      const removed = registry.removeAgent(agent.id);
      expect(removed).toBe(true);
      expect(registry.getSpecialists()).toHaveLength(0);
      expect(registry.getAgent(agent.id)).toBeUndefined();
    });

    it('unregisters alias when removing', () => {
      const unregisterSpy = vi.spyOn(messageBus, 'unregisterAlias');
      const agent = registry.createAgent(ROLE_DEFINITIONS['frontend']);

      registry.removeAgent(agent.id);
      expect(unregisterSpy).toHaveBeenCalledWith('frontend');
    });

    it('fires onAgentRemoved event', () => {
      const listener = vi.fn();
      registry.onAgentRemoved(listener);

      const agent = registry.createAgent(ROLE_DEFINITIONS['backend']);
      registry.removeAgent(agent.id);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(agent);
    });

    it('cannot remove the Team Lead', () => {
      const teamLead = registry.getTeamLead()!;
      const removed = registry.removeAgent(teamLead.id);

      expect(removed).toBe(false);
      expect(registry.getTeamLead()).toBeDefined();
    });

    it('returns false for unknown agent ID', () => {
      expect(registry.removeAgent('nonexistent')).toBe(false);
    });
  });

  // ─── Queries ──────────────────────────────────────────────────────

  describe('queries', () => {
    it('getAgentByRole finds dynamically created agents', () => {
      registry.buildTeam();
      registry.createAgent(ROLE_DEFINITIONS['frontend']);

      const agent = registry.getAgentByRole('frontend');
      expect(agent).toBeDefined();
      expect(agent?.roleConfig.role).toBe('frontend');
    });

    it('getAgentByRole returns undefined for missing role', () => {
      registry.buildTeam();
      expect(registry.getAgentByRole('security')).toBeUndefined();
    });

    it('getAgent finds by ID', () => {
      registry.buildTeam();
      const agent = registry.createAgent(ROLE_DEFINITIONS['backend']);

      expect(registry.getAgent(agent.id)).toBe(agent);
    });
  });

  // ─── Lifecycle ────────────────────────────────────────────────────

  it('startAll and stopAll run without errors', () => {
    registry.buildTeam();
    registry.createAgent(ROLE_DEFINITIONS['frontend']);

    expect(() => registry.startAll()).not.toThrow();
    expect(() => registry.stopAll()).not.toThrow();
  });

  it('pauseAll and resumeAll run without errors', () => {
    registry.buildTeam();
    registry.createAgent(ROLE_DEFINITIONS['frontend']);
    registry.startAll();

    expect(() => registry.pauseAll()).not.toThrow();
    expect(() => registry.resumeAll()).not.toThrow();
  });

  it('disposeAll clears all agents', () => {
    registry.buildTeam();
    registry.createAgent(ROLE_DEFINITIONS['frontend']);
    registry.createAgent(ROLE_DEFINITIONS['backend']);
    registry.disposeAll();

    expect(registry.getAllAgents()).toHaveLength(0);
    expect(registry.getTeamLead()).toBeNull();
  });

  // ─── removeAllSpecialists ──────────────────────────────────────────

  describe('removeAllSpecialists', () => {
    it('removes all specialists but keeps Team Lead', () => {
      registry.buildTeam();
      registry.createAgent(ROLE_DEFINITIONS['frontend']);
      registry.createAgent(ROLE_DEFINITIONS['backend']);
      registry.createAgent(ROLE_DEFINITIONS['tester']);

      expect(registry.getSpecialists()).toHaveLength(3);

      const removed = registry.removeAllSpecialists();

      expect(removed).toBe(3);
      expect(registry.getSpecialists()).toHaveLength(0);
      expect(registry.getTeamLead()).toBeDefined();
      expect(registry.getAllAgents()).toHaveLength(1);
    });

    it('returns 0 when no specialists exist', () => {
      registry.buildTeam();
      const removed = registry.removeAllSpecialists();
      expect(removed).toBe(0);
    });

    it('fires onAgentRemoved for each removed specialist', () => {
      registry.buildTeam();
      const listener = vi.fn();
      registry.onAgentRemoved(listener);

      registry.createAgent(ROLE_DEFINITIONS['frontend']);
      registry.createAgent(ROLE_DEFINITIONS['backend']);

      registry.removeAllSpecialists();

      expect(listener).toHaveBeenCalledTimes(2);
    });
  });

  it('messages addressed by role name reach the correct agent', () => {
    registry.buildTeam();
    const agent = registry.createAgent(ROLE_DEFINITIONS['frontend']);

    const handler = vi.fn();
    messageBus.subscribe(agent.id, handler);

    messageBus.publish({
      id: 'test-msg-1',
      type: 0 as any,
      fromAgentId: 'test-sender',
      toAgentId: 'frontend',
      payload: { test: true },
      timestamp: new Date(),
      replyToMessageId: null,
    });

    // Handler called once from the subscribe above, plus the agent's
    // own start() subscription — either way, the message was routed.
    expect(handler).toHaveBeenCalled();
  });
});
