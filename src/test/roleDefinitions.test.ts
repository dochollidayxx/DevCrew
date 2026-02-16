import { describe, it, expect } from 'vitest';
import { ROLE_DEFINITIONS } from '../agents/roles/roleDefinitions';
import { AgentRole } from '../types';

describe('Role Definitions', () => {
  const allRoles: AgentRole[] = [
    'team-lead',
    'architect',
    'frontend',
    'backend',
    'tester',
    'reviewer',
    'devops',
    'security',
    'docs',
  ];

  it('defines all 9 roles', () => {
    expect(Object.keys(ROLE_DEFINITIONS)).toHaveLength(9);
  });

  for (const role of allRoles) {
    describe(`role: ${role}`, () => {
      it('has correct role field', () => {
        expect(ROLE_DEFINITIONS[role].role).toBe(role);
      });

      it('has a non-empty name', () => {
        expect(ROLE_DEFINITIONS[role].name.length).toBeGreaterThan(0);
      });

      it('has a non-empty description', () => {
        expect(ROLE_DEFINITIONS[role].description.length).toBeGreaterThan(0);
      });

      it('has a non-empty systemPrompt', () => {
        expect(ROLE_DEFINITIONS[role].systemPrompt.length).toBeGreaterThan(0);
      });

      it('has at least one capability', () => {
        expect(ROLE_DEFINITIONS[role].capabilities.length).toBeGreaterThan(0);
      });

      it('has an icon', () => {
        expect(ROLE_DEFINITIONS[role].icon.length).toBeGreaterThan(0);
      });
    });
  }
});
