import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentRegistry } from '../agents/registry';
import { MessageBus } from '../communication/messageBus';
import { FileManager } from '../fileops/fileManager';
import { TaskBoard } from '../orchestration/taskBoard';
import { LLMService } from '../types';

function createMockLLM(): LLMService {
  return {
    modelName: 'test-model',
    sendMessages: vi.fn().mockResolvedValue('mock response'),
    streamMessages: vi.fn(),
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
    registry.disposeAll();
    messageBus.dispose();
    fileManager.dispose();
    taskBoard.dispose();
  });

  it('buildTeam creates Team Lead + specialists', () => {
    registry.buildTeam([
      'team-lead',
      'frontend',
      'backend',
      'tester',
    ]);

    const all = registry.getAllAgents();
    expect(all).toHaveLength(4); // team-lead + 3 specialists

    expect(registry.getTeamLead()).toBeDefined();
    expect(registry.getTeamLead()?.roleConfig.role).toBe('team-lead');
  });

  it('always creates Team Lead even if not in roles list', () => {
    registry.buildTeam(['frontend', 'backend']);

    expect(registry.getTeamLead()).toBeDefined();
    expect(registry.getAllAgents()).toHaveLength(3);
  });

  it('does not duplicate Team Lead when listed', () => {
    registry.buildTeam(['team-lead', 'team-lead', 'frontend']);

    // team-lead appears once, 'frontend' once
    const leads = registry
      .getAllAgents()
      .filter((a) => a.roleConfig.role === 'team-lead');
    expect(leads).toHaveLength(1);
  });

  it('getSpecialists excludes Team Lead', () => {
    registry.buildTeam(['team-lead', 'frontend', 'backend']);

    const specialists = registry.getSpecialists();
    expect(specialists).toHaveLength(2);
    expect(specialists.every((s) => s.roleConfig.role !== 'team-lead')).toBe(
      true
    );
  });

  it('getAgentByRole finds the correct agent', () => {
    registry.buildTeam(['team-lead', 'frontend', 'backend', 'tester']);

    const frontend = registry.getAgentByRole('frontend');
    expect(frontend).toBeDefined();
    expect(frontend?.roleConfig.role).toBe('frontend');
  });

  it('getAgentByRole returns undefined for missing role', () => {
    registry.buildTeam(['team-lead', 'frontend']);

    expect(registry.getAgentByRole('security')).toBeUndefined();
  });

  it('getAgent finds by ID', () => {
    registry.buildTeam(['team-lead', 'backend']);

    const all = registry.getAllAgents();
    const found = registry.getAgent(all[0].id);
    expect(found).toBe(all[0]);
  });

  it('startAll and stopAll run without errors', () => {
    registry.buildTeam(['team-lead', 'frontend', 'backend']);

    expect(() => registry.startAll()).not.toThrow();
    expect(() => registry.stopAll()).not.toThrow();
  });

  it('disposeAll clears all agents', () => {
    registry.buildTeam(['team-lead', 'frontend', 'backend']);
    registry.disposeAll();

    expect(registry.getAllAgents()).toHaveLength(0);
    expect(registry.getTeamLead()).toBeNull();
  });

  it('buildTeam disposes previous team before building new one', () => {
    registry.buildTeam(['team-lead', 'frontend']);
    const firstLead = registry.getTeamLead();

    registry.buildTeam(['team-lead', 'backend', 'tester']);
    const secondLead = registry.getTeamLead();

    expect(secondLead).not.toBe(firstLead);
    expect(registry.getSpecialists()).toHaveLength(2);
  });

  it('skips unknown roles gracefully', () => {
    registry.buildTeam(['team-lead', 'frontend', 'unknown-role' as any]);

    // Should have team-lead + frontend only
    expect(registry.getAllAgents()).toHaveLength(2);
  });

  // ─── Alias Registration ─────────────────────────────────────────────

  describe('alias registration via buildTeam', () => {
    it('buildTeam calls messageBus.registerAlias for each agent role', () => {
      const registerAliasSpy = vi.spyOn(messageBus, 'registerAlias');

      registry.buildTeam(['team-lead', 'frontend', 'backend']);

      // team-lead + frontend + backend = 3 calls
      expect(registerAliasSpy).toHaveBeenCalledTimes(3);
    });

    it('Team Lead is registered with alias "team-lead"', () => {
      const registerAliasSpy = vi.spyOn(messageBus, 'registerAlias');

      registry.buildTeam(['team-lead', 'frontend']);

      const teamLeadCall = registerAliasSpy.mock.calls.find(
        (call) => call[0] === 'team-lead'
      );
      expect(teamLeadCall).toBeDefined();
      expect(teamLeadCall![1]).toBe(registry.getTeamLead()!.id);
    });

    it('specialists are registered with their role names', () => {
      const registerAliasSpy = vi.spyOn(messageBus, 'registerAlias');

      registry.buildTeam(['team-lead', 'frontend', 'backend']);

      const frontendAgent = registry.getAgentByRole('frontend');
      const frontendCall = registerAliasSpy.mock.calls.find(
        (call) => call[0] === 'frontend'
      );
      expect(frontendCall).toBeDefined();
      expect(frontendCall![1]).toBe(frontendAgent!.id);

      const backendAgent = registry.getAgentByRole('backend');
      const backendCall = registerAliasSpy.mock.calls.find(
        (call) => call[0] === 'backend'
      );
      expect(backendCall).toBeDefined();
      expect(backendCall![1]).toBe(backendAgent!.id);
    });

    it('messages addressed by role name reach the correct agent after buildTeam', () => {
      registry.buildTeam(['team-lead', 'frontend', 'backend']);
      registry.startAll();

      // The frontend agent should now be reachable via "frontend" alias
      const frontendAgent = registry.getAgentByRole('frontend');
      expect(frontendAgent).toBeDefined();

      // Send a message addressed to "frontend" role and verify it arrives
      const handler = vi.fn();
      messageBus.subscribe(frontendAgent!.id, handler);

      messageBus.publish({
        id: 'test-msg-1',
        type: 0 as any, // StatusUpdate
        fromAgentId: 'test-sender',
        toAgentId: 'frontend',
        payload: { test: true },
        timestamp: new Date(),
        replyToMessageId: null,
      });

      // Handler was called twice: once from the agent's own start() subscription,
      // and once from our test subscription. But either way, the message reached
      // the agent's subscriber.
      expect(handler).toHaveBeenCalled();
    });
  });
});
