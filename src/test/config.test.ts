import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getConfig, validateConfig } from '../config/settings';
import { DevCrewConfig } from '../types';
import * as vscode from 'vscode';

describe('Config - getConfig', () => {
  it('returns default configuration', () => {
    const config = getConfig();

    expect(config.team.composition).toEqual([
      'architect',
      'frontend',
      'backend',
      'tester',
      'reviewer',
    ]);
    expect(config.team.maxParallelAgents).toBe(3);
    expect(config.fileOps.requireApproval).toBe(true);
    expect(config.fileOps.autoSave).toBe(true);
    expect(config.notifications.level).toBe('important');
  });

  it('respects custom values from workspace configuration', () => {
    const mockGet = vi.fn().mockImplementation((key: string, defaultValue?: unknown) => {
      const overrides: Record<string, unknown> = {
        'team.composition': ['frontend', 'backend'],
        'team.maxParallelAgents': 5,
        'fileOps.requireApproval': false,
      };
      return overrides[key] ?? defaultValue;
    });

    const origGetConfig = vscode.workspace.getConfiguration;
    (vscode.workspace as any).getConfiguration = () => ({ get: mockGet });

    const config = getConfig();
    expect(config.team.composition).toEqual(['frontend', 'backend']);
    expect(config.team.maxParallelAgents).toBe(5);
    expect(config.fileOps.requireApproval).toBe(false);

    (vscode.workspace as any).getConfiguration = origGetConfig;
  });
});

describe('Config - validateConfig', () => {
  it('returns no issues for a valid config', () => {
    const config: DevCrewConfig = {
      team: {
        composition: ['frontend', 'backend'],
        maxParallelAgents: 3,
      },
      fileOps: {
        requireApproval: true,
        autoSave: true,
      },
      notifications: {
        level: 'important',
      },
    };

    expect(validateConfig(config)).toEqual([]);
  });

  it('returns an issue when team composition is empty', () => {
    const config: DevCrewConfig = {
      team: {
        composition: [],
        maxParallelAgents: 3,
      },
      fileOps: {
        requireApproval: true,
        autoSave: true,
      },
      notifications: {
        level: 'important',
      },
    };

    const issues = validateConfig(config);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('empty');
  });
});
