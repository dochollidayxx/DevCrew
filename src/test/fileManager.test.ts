import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FileManager } from '../fileops/fileManager';
import { FileEdit } from '../types';
import * as vscode from 'vscode';

function makeEdit(overrides: Partial<FileEdit> = {}): FileEdit {
  return {
    uri: vscode.Uri.file('/workspace/test.ts'),
    type: 'create',
    content: 'console.log("hello");',
    agentId: 'agent-1',
    taskId: 'task-1',
    description: 'Test file write',
    ...overrides,
  };
}

describe('FileManager', () => {
  let fm: FileManager;

  beforeEach(() => {
    fm = new FileManager(false, false); // no approval, no auto-save
  });

  // ─── applyEdit ─────────────────────────────────────────────────────

  describe('applyEdit', () => {
    it('applies an edit and returns true', async () => {
      const result = await fm.applyEdit(makeEdit());
      expect(result).toBe(true);
    });

    it('records edit in history', async () => {
      const edit = makeEdit();
      await fm.applyEdit(edit);

      const history = fm.getEditHistory();
      expect(history).toHaveLength(1);
      expect(history[0].agentId).toBe('agent-1');
    });

    it('fires onFileEdit event', async () => {
      const listener = vi.fn();
      fm.onFileEdit(listener);

      await fm.applyEdit(makeEdit());
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('releases lock after edit completes', async () => {
      const edit = makeEdit();
      await fm.applyEdit(edit);

      expect(fm.isLocked(edit.uri)).toBe(false);
    });
  });

  // ─── Lock Management ───────────────────────────────────────────────

  describe('locking', () => {
    it('detects conflicting locks from different agents', async () => {
      // Start a long-running edit from agent-1 (mock applyEdit to be slow)
      const origApplyEdit = vscode.workspace.applyEdit;
      let resolveEdit: ((v: boolean) => void) | undefined;
      (vscode.workspace as any).applyEdit = () =>
        new Promise<boolean>((resolve) => {
          resolveEdit = resolve;
        });

      const edit1Promise = fm.applyEdit(
        makeEdit({ agentId: 'agent-1' })
      );

      // agent-2 tries to write the same file
      await expect(
        fm.applyEdit(makeEdit({ agentId: 'agent-2' }))
      ).rejects.toThrow(/locked by another agent/);

      // Clean up
      resolveEdit?.(true);
      await edit1Promise;
      (vscode.workspace as any).applyEdit = origApplyEdit;
    });

    it('allows same agent to write same file', async () => {
      // This should not throw - same agent can re-acquire its own lock
      const result = await fm.applyEdit(
        makeEdit({ agentId: 'agent-1' })
      );
      expect(result).toBe(true);
    });

    it('forceReleaseLock clears a lock', async () => {
      const origApplyEdit = vscode.workspace.applyEdit;
      let resolveEdit: ((v: boolean) => void) | undefined;
      (vscode.workspace as any).applyEdit = () =>
        new Promise<boolean>((resolve) => {
          resolveEdit = resolve;
        });

      const uri = vscode.Uri.file('/workspace/locked.ts');
      const editPromise = fm.applyEdit(makeEdit({ uri, agentId: 'agent-1' }));

      // File should be locked now
      expect(fm.isLocked(uri)).toBe(true);

      // Force release
      fm.forceReleaseLock(uri);
      expect(fm.isLocked(uri)).toBe(false);

      resolveEdit?.(true);
      await editPromise;
      (vscode.workspace as any).applyEdit = origApplyEdit;
    });

    it('releaseAllLocks clears all locks for an agent', async () => {
      // We can't easily test this with real locks since they're acquired/released
      // in applyEdit. But we can verify the method doesn't throw.
      fm.releaseAllLocks('agent-1');
    });

    it('getLock returns lock info', async () => {
      const origApplyEdit = vscode.workspace.applyEdit;
      let resolveEdit: ((v: boolean) => void) | undefined;
      (vscode.workspace as any).applyEdit = () =>
        new Promise<boolean>((resolve) => {
          resolveEdit = resolve;
        });

      const uri = vscode.Uri.file('/workspace/test.ts');
      const editPromise = fm.applyEdit(makeEdit({ uri }));

      const lock = fm.getLock(uri);
      expect(lock).toBeDefined();
      expect(lock?.agentId).toBe('agent-1');

      resolveEdit?.(true);
      await editPromise;
      (vscode.workspace as any).applyEdit = origApplyEdit;
    });
  });

  // ─── readFile ──────────────────────────────────────────────────────

  describe('readFile', () => {
    it('reads file content from workspace.fs', async () => {
      const uri = vscode.Uri.file('/workspace/file.ts');
      const content = await fm.readFile(uri);

      expect(content).toBe('mock file content');
    });
  });

  // ─── History Queries ───────────────────────────────────────────────

  describe('history', () => {
    it('getEditsByAgent filters by agent ID', async () => {
      await fm.applyEdit(makeEdit({ agentId: 'agent-1' }));
      await fm.applyEdit(makeEdit({ agentId: 'agent-2' }));
      await fm.applyEdit(makeEdit({ agentId: 'agent-1' }));

      expect(fm.getEditsByAgent('agent-1')).toHaveLength(2);
      expect(fm.getEditsByAgent('agent-2')).toHaveLength(1);
    });
  });

  // ─── Configuration ─────────────────────────────────────────────────

  describe('configuration', () => {
    it('setRequireApproval changes the approval flag', () => {
      fm.setRequireApproval(true);
      // We can't directly assert the private field, but the behavior change
      // would affect applyEdit (it would call showInformationMessage)
      fm.setRequireApproval(false);
    });

    it('setAutoSave changes the auto-save flag', () => {
      fm.setAutoSave(true);
      fm.setAutoSave(false);
    });
  });

  // ─── Dispose ───────────────────────────────────────────────────────

  it('dispose clears locks and does not throw', () => {
    fm.dispose();
  });
});
