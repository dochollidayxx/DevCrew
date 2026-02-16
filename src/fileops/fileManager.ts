import * as vscode from 'vscode';
import { FileEdit, FileLock } from '../types';

/**
 * Manages all file operations for DevCrew agents using VSCode's
 * WorkspaceEdit API. Provides file locking to prevent conflicts
 * between parallel agents, and optionally requires user approval.
 */
export class FileManager {
  private locks: Map<string, FileLock> = new Map();
  private editHistory: FileEdit[] = [];
  private requireApproval: boolean;
  private autoSave: boolean;

  private readonly _onFileEdit = new vscode.EventEmitter<FileEdit>();
  readonly onFileEdit = this._onFileEdit.event;

  constructor(requireApproval: boolean, autoSave: boolean) {
    this.requireApproval = requireApproval;
    this.autoSave = autoSave;
  }

  // ─── File Operations ──────────────────────────────────────────────────

  async applyEdit(edit: FileEdit): Promise<boolean> {
    const uriKey = edit.uri.toString();

    // Check for lock conflicts
    const existingLock = this.locks.get(uriKey);
    if (existingLock && existingLock.agentId !== edit.agentId) {
      throw new Error(
        `File ${edit.uri.fsPath} is locked by agent ${existingLock.agentId}`
      );
    }

    // Acquire lock
    this.locks.set(uriKey, {
      uri: uriKey,
      agentId: edit.agentId,
      acquiredAt: new Date(),
      taskId: edit.taskId,
    });

    try {
      // Optionally ask user for approval
      if (this.requireApproval) {
        const approved = await this.requestApproval(edit);
        if (!approved) {
          return false;
        }
      }

      // Apply the edit using VSCode WorkspaceEdit
      const workspaceEdit = new vscode.WorkspaceEdit();

      switch (edit.type) {
        case 'create': {
          workspaceEdit.createFile(edit.uri, {
            overwrite: true,
            ignoreIfExists: false,
          });
          workspaceEdit.insert(edit.uri, new vscode.Position(0, 0), edit.content);
          break;
        }
        case 'replace': {
          if (edit.range) {
            workspaceEdit.replace(edit.uri, edit.range, edit.content);
          } else {
            // Full file replacement
            const doc = await vscode.workspace.openTextDocument(edit.uri);
            const fullRange = new vscode.Range(
              doc.positionAt(0),
              doc.positionAt(doc.getText().length)
            );
            workspaceEdit.replace(edit.uri, fullRange, edit.content);
          }
          break;
        }
        case 'insert': {
          const position = edit.range?.start ?? new vscode.Position(0, 0);
          workspaceEdit.insert(edit.uri, position, edit.content);
          break;
        }
        case 'delete': {
          if (edit.range) {
            workspaceEdit.delete(edit.uri, edit.range);
          } else {
            workspaceEdit.deleteFile(edit.uri);
          }
          break;
        }
      }

      const success = await vscode.workspace.applyEdit(workspaceEdit);

      if (success) {
        this.editHistory.push(edit);
        this._onFileEdit.fire(edit);

        // Auto-save if configured
        if (this.autoSave) {
          const doc = vscode.workspace.textDocuments.find(
            (d) => d.uri.toString() === edit.uri.toString()
          );
          if (doc && doc.isDirty) {
            await doc.save();
          }
        }
      }

      return success;
    } finally {
      // Release lock
      this.locks.delete(uriKey);
    }
  }

  async readFile(uri: vscode.Uri): Promise<string> {
    try {
      // Try to read from open documents first (fresher content)
      const openDoc = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === uri.toString()
      );
      if (openDoc) {
        return openDoc.getText();
      }

      // Fall back to filesystem
      const bytes = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(bytes).toString('utf-8');
    } catch {
      throw new Error(`Cannot read file: ${uri.fsPath}`);
    }
  }

  async listFiles(
    baseUri: vscode.Uri,
    pattern: string
  ): Promise<vscode.Uri[]> {
    const relativePattern = new vscode.RelativePattern(baseUri, pattern);
    return vscode.workspace.findFiles(relativePattern);
  }

  // ─── Lock Management ──────────────────────────────────────────────────

  isLocked(uri: vscode.Uri): boolean {
    return this.locks.has(uri.toString());
  }

  getLock(uri: vscode.Uri): FileLock | undefined {
    return this.locks.get(uri.toString());
  }

  forceReleaseLock(uri: vscode.Uri): void {
    this.locks.delete(uri.toString());
  }

  releaseAllLocks(agentId: string): void {
    for (const [key, lock] of this.locks) {
      if (lock.agentId === agentId) {
        this.locks.delete(key);
      }
    }
  }

  // ─── Approval ─────────────────────────────────────────────────────────

  private async requestApproval(edit: FileEdit): Promise<boolean> {
    const action = edit.type === 'create' ? 'Create' : 'Modify';
    const result = await vscode.window.showInformationMessage(
      `${edit.description}\n\n${action}: ${vscode.workspace.asRelativePath(edit.uri)}`,
      { modal: false },
      'Approve',
      'Reject',
      'Approve All'
    );

    if (result === 'Approve All') {
      this.requireApproval = false;
      return true;
    }

    return result === 'Approve';
  }

  // ─── History ──────────────────────────────────────────────────────────

  getEditHistory(): FileEdit[] {
    return [...this.editHistory];
  }

  getEditsByAgent(agentId: string): FileEdit[] {
    return this.editHistory.filter((e) => e.agentId === agentId);
  }

  // ─── Configuration ────────────────────────────────────────────────────

  setRequireApproval(value: boolean): void {
    this.requireApproval = value;
  }

  setAutoSave(value: boolean): void {
    this.autoSave = value;
  }

  dispose(): void {
    this.locks.clear();
    this._onFileEdit.dispose();
  }
}
