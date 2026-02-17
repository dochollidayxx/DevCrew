import * as vscode from 'vscode';

// ─── Agent Roles ──────────────────────────────────────────────────────────────

/**
 * Agent roles are free-form strings. The Team Lead creates agents
 * dynamically with whatever roles the task requires.
 * Well-known roles (e.g. 'team-lead', 'architect') have templates
 * in roleDefinitions.ts but any string is valid.
 */
export type AgentRole = string;

export interface AgentRoleConfig {
  role: AgentRole;
  name: string;
  description: string;
  systemPrompt: string;
  capabilities: string[];
  icon: string;
}

// ─── Agent State ──────────────────────────────────────────────────────────────

export enum AgentStatus {
  Idle = 'idle',
  Working = 'working',
  Blocked = 'blocked',
  Paused = 'paused',
  WaitingForReview = 'waiting_for_review',
  WaitingForDependency = 'waiting_for_dependency',
  Error = 'error',
  Done = 'done',
}

export interface AgentState {
  id: string;
  role: AgentRole;
  name: string;
  status: AgentStatus;
  currentTaskId: string | null;
  completedTaskIds: string[];
  blockerDescription: string | null;
  lastActivity: Date;
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

export enum TaskStatus {
  Pending = 'pending',
  Assigned = 'assigned',
  InProgress = 'in_progress',
  InReview = 'in_review',
  Blocked = 'blocked',
  Paused = 'paused',
  Completed = 'completed',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

export enum TaskPriority {
  Critical = 0,
  High = 1,
  Medium = 2,
  Low = 3,
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string | null;
  dependsOn: string[];
  blockedBy: string[];
  subtasks: string[];
  parentTaskId: string | null;
  files: TaskFileOperation[];
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  metadata: Record<string, unknown>;
}

export interface TaskFileOperation {
  type: 'create' | 'modify' | 'delete';
  filePath: string;
  description: string;
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export enum MessageType {
  // Agent lifecycle
  StatusUpdate = 'status_update',
  TaskAssigned = 'task_assigned',
  TaskCompleted = 'task_completed',
  TaskFailed = 'task_failed',
  BlockerRaised = 'blocker_raised',
  BlockerResolved = 'blocker_resolved',

  // Inter-agent
  Question = 'question',
  Answer = 'answer',
  ReviewRequest = 'review_request',
  ReviewResult = 'review_result',
  CodeSuggestion = 'code_suggestion',

  // File operations
  FileWriteRequest = 'file_write_request',
  FileWriteApproved = 'file_write_approved',
  FileWriteRejected = 'file_write_rejected',
  FileConflict = 'file_conflict',

  // Team Lead
  TaskDecomposition = 'task_decomposition',
  TeamDirective = 'team_directive',
  IntegrationStart = 'integration_start',
  IntegrationComplete = 'integration_complete',
  UserFeedbackRequest = 'user_feedback_request',
  UserFeedbackResponse = 'user_feedback_response',

  // Dynamic agent lifecycle
  AgentCreated = 'agent_created',
  AgentRemoved = 'agent_removed',

  // Progress
  IterationProgress = 'iteration_progress',
  FileWritten = 'file_written',
  FileEdited = 'file_edited',
  FileRead = 'file_read',
  FilesListed = 'files_listed',
  CommandExecuted = 'command_executed',
  StreamingChunk = 'streaming_chunk',

  // System
  Error = 'error',
  Log = 'log',
}

export interface Message {
  id: string;
  type: MessageType;
  fromAgentId: string;
  toAgentId: string | null; // null = broadcast
  payload: unknown;
  timestamp: Date;
  replyToMessageId: string | null;
}

// ─── File Operations ──────────────────────────────────────────────────────────

export interface FileEdit {
  uri: vscode.Uri;
  type: 'create' | 'replace' | 'insert' | 'delete';
  range?: vscode.Range;
  content: string;
  agentId: string;
  taskId: string;
  description: string;
}

export interface FileLock {
  uri: string;
  agentId: string;
  acquiredAt: Date;
  taskId: string;
}

// ─── LLM Integration ─────────────────────────────────────────────────────────

/**
 * Wraps VSCode's Language Model API (vscode.lm) for use by agents.
 * Uses VSCode's Language Model API - no API keys needed.
 */
export interface LLMService {
  /**
   * Send a conversation to the language model and get a complete response.
   * Uses vscode.lm.selectChatModels() under the hood.
   */
  sendMessages(
    messages: LLMMessage[],
    token?: vscode.CancellationToken
  ): Promise<string>;

  /**
   * Stream a response from the language model.
   */
  streamMessages(
    messages: LLMMessage[],
    token?: vscode.CancellationToken
  ): Promise<AsyncIterable<string>>;

  /**
   * Stream a response and call onChunk with each partial chunk as it arrives.
   * Returns the full concatenated response when done.
   */
  streamWithProgress(
    messages: LLMMessage[],
    onChunk: (chunk: string, accumulated: string) => void,
    token?: vscode.CancellationToken
  ): Promise<string>;

  /** The display name of the selected model. */
  readonly modelName: string;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ─── Configuration ────────────────────────────────────────────────────────────

export interface DevCrewConfig {
  team: {
    maxParallelAgents: number;
  };
  agent: {
    maxIterationsPerTask: number;
  };
  fileOps: {
    requireApproval: boolean;
    autoSave: boolean;
  };
  notifications: {
    level: 'all' | 'important' | 'errors-only' | 'none';
  };
}

// ─── Events ───────────────────────────────────────────────────────────────────

export interface DevCrewEvents {
  onAgentStateChange: vscode.Event<AgentState>;
  onTaskChange: vscode.Event<Task>;
  onMessage: vscode.Event<Message>;
  onFileEdit: vscode.Event<FileEdit>;
  onTeamStart: vscode.Event<void>;
  onTeamStop: vscode.Event<void>;
}
