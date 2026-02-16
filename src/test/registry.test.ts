import { describe, it, expect, beforeEach, vi } from 'vitest';
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
});
