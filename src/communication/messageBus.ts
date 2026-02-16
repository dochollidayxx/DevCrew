import * as vscode from 'vscode';
import { Message, MessageType } from '../types';

type MessageHandler = (message: Message) => void;

/**
 * Central message bus for inter-agent communication. Supports:
 * - Targeted messages (to a specific agent)
 * - Broadcast messages (to all subscribers)
 * - Type-based filtering
 * - Message history for debugging
 */
export class MessageBus {
  private subscribers: Map<string, MessageHandler> = new Map();
  private typeSubscribers: Map<MessageType, Set<MessageHandler>> = new Map();
  private roleAliases: Map<string, string> = new Map();
  private messageHistory: Message[] = [];
  private readonly maxHistorySize = 1000;

  private readonly _onMessage = new vscode.EventEmitter<Message>();
  readonly onMessage = this._onMessage.event;

  /**
   * Subscribe an agent to receive messages targeted at it or broadcast.
   */
  subscribe(agentId: string, handler: MessageHandler): vscode.Disposable {
    this.subscribers.set(agentId, handler);
    return new vscode.Disposable(() => {
      this.subscribers.delete(agentId);
    });
  }

  /**
   * Register a role name as an alias for an agent ID,
   * so messages addressed to the role name are routed to the correct agent.
   */
  registerAlias(alias: string, agentId: string): void {
    this.roleAliases.set(alias, agentId);
  }

  /**
   * Remove a previously registered alias.
   */
  unregisterAlias(alias: string): void {
    this.roleAliases.delete(alias);
  }

  /**
   * Subscribe to a specific message type regardless of target.
   */
  subscribeToType(
    type: MessageType,
    handler: MessageHandler
  ): vscode.Disposable {
    if (!this.typeSubscribers.has(type)) {
      this.typeSubscribers.set(type, new Set());
    }
    this.typeSubscribers.get(type)!.add(handler);
    return new vscode.Disposable(() => {
      this.typeSubscribers.get(type)?.delete(handler);
    });
  }

  /**
   * Publish a message. Routes to the target agent or broadcasts to all.
   */
  publish(message: Message): void {
    // Store in history
    this.messageHistory.push(message);
    if (this.messageHistory.length > this.maxHistorySize) {
      this.messageHistory.shift();
    }

    // Fire global event (for UI, logging, etc.)
    this._onMessage.fire(message);

    // Resolve role aliases so agents can address messages by role name
    const resolvedToAgentId = message.toAgentId
      ? (this.roleAliases.get(message.toAgentId) ?? message.toAgentId)
      : null;

    // Route to target or broadcast
    if (resolvedToAgentId) {
      const handler = this.subscribers.get(resolvedToAgentId);
      if (handler) {
        handler(message);
      }
    } else {
      // Broadcast to all except sender
      for (const [agentId, handler] of this.subscribers) {
        if (agentId !== message.fromAgentId) {
          handler(message);
        }
      }
    }

    // Notify type subscribers
    const typeHandlers = this.typeSubscribers.get(message.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        handler(message);
      }
    }
  }

  /**
   * Get recent messages, optionally filtered.
   */
  getHistory(filter?: {
    agentId?: string;
    type?: MessageType;
    limit?: number;
  }): Message[] {
    let messages = this.messageHistory;

    if (filter?.agentId) {
      messages = messages.filter(
        (m) =>
          m.fromAgentId === filter.agentId || m.toAgentId === filter.agentId
      );
    }

    if (filter?.type) {
      messages = messages.filter((m) => m.type === filter.type);
    }

    if (filter?.limit) {
      messages = messages.slice(-filter.limit);
    }

    return messages;
  }

  clear(): void {
    this.messageHistory = [];
  }

  dispose(): void {
    this.subscribers.clear();
    this.typeSubscribers.clear();
    this.roleAliases.clear();
    this.messageHistory = [];
    this._onMessage.dispose();
  }
}
