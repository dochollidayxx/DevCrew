import { describe, it, expect, vi } from 'vitest';
import { getConfig, validateConfig } from '../config/settings';
import { DevCrewConfig } from '../types';
import * as vscode from 'vscode';

describe('Config - getConfig', () => {
  it('returns default configuration', () => {
    const config = getConfig();

    expect(config.team.maxParallelAgents).toBe(3);
    expect(config.agent.maxIterationsPerTask).toBe(50);
    expect(config.fileOps.requireApproval).toBe(true);
    expect(config.fileOps.autoSave).toBe(true);
    expect(config.notifications.level).toBe('important');
  });

  it('respects custom values from workspace configuration', () => {
    const mockGet = vi.fn().mockImplementation((key: string, defaultValue?: unknown) => {
      const overrides: Record<string, unknown> = {
        'team.maxParallelAgents': 5,
        'fileOps.requireApproval': false,
      };
      return overrides[key] ?? defaultValue;
    });

    const origGetConfig = vscode.workspace.getConfiguration;
    (vscode.workspace as any).getConfiguration = () => ({ get: mockGet });

    const config = getConfig();
    expect(config.team.maxParallelAgents).toBe(5);
    expect(config.fileOps.requireApproval).toBe(false);

    (vscode.workspace as any).getConfiguration = origGetConfig;
  });
});

describe('Config - validateConfig', () => {
  it('returns no issues for a valid config', () => {
    const config: DevCrewConfig = {
      team: {
        maxParallelAgents: 3,
      },
      agent: {
        maxIterationsPerTask: 50,
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
});
