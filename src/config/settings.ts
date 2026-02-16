import * as vscode from 'vscode';
import { AgentRole, DevCrewConfig } from '../types';

/**
 * Reads DevCrew configuration from VSCode settings and provides
 * a typed, validated config object. LLM is handled via VSCode's
 * built-in Language Model API, so no API key config needed.
 */
export function getConfig(): DevCrewConfig {
  const config = vscode.workspace.getConfiguration('devcrew');

  return {
    team: {
      composition: config.get<AgentRole[]>('team.composition', [
        'architect',
        'frontend',
        'backend',
        'tester',
        'reviewer',
      ]),
      maxParallelAgents: config.get<number>('team.maxParallelAgents', 3),
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
export function validateConfig(config: DevCrewConfig): string[] {
  const issues: string[] = [];

  if (config.team.composition.length === 0) {
    issues.push('Team composition is empty. Add at least one role.');
  }

  return issues;
}
