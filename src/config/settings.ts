import * as vscode from 'vscode';
import { DevCrewConfig } from '../types';

/**
 * Reads DevCrew configuration from VSCode settings and provides
 * a typed, validated config object. LLM is handled via VSCode's
 * built-in Language Model API, so no API key config needed.
 *
 * Note: Team composition is no longer configured here — the Team Lead
 * dynamically creates agents based on the user's request.
 */
export function getConfig(): DevCrewConfig {
  const config = vscode.workspace.getConfiguration('devcrew');

  return {
    team: {
      maxParallelAgents: config.get<number>('team.maxParallelAgents', 3),
    },
    agent: {
      maxIterationsPerTask: config.get<number>('agent.maxIterationsPerTask', 50),
    },
    fileOps: {
      requireApproval: config.get<boolean>('fileOps.requireApproval', true),
      autoSave: config.get<boolean>('fileOps.autoSave', true),
    },
    notifications: {
      level: config.get<'all' | 'important' | 'errors-only' | 'none'>(
        'notifications.level',
        'important'
      ),
    },
  };
}

/**
 * Validates configuration and returns a list of issues.
 */
export function validateConfig(_config: DevCrewConfig): string[] {
  return [];
}
