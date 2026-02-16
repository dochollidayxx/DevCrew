import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageBus } from '../communication/messageBus';
import { Message, MessageType } from '../types';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: MessageType.StatusUpdate,
    fromAgentId: 'agent-a',
    toAgentId: null,
    payload: { message: 'test' },
    timestamp: new Date(),
    replyToMessageId: null,
    ...overrides,
  };
}

describe('MessageBus', () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = new MessageBus();
  });

  // ─── Subscription & Routing ────────────────────────────────────────

  it('delivers targeted messages to the correct subscriber', () => {
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    bus.subscribe('agent-a', handlerA);
    bus.subscribe('agent-b', handlerB);

    const msg = makeMessage({ fromAgentId: 'agent-a', toAgentId: 'agent-b' });
    bus.publish(msg);

    expect(handlerB).toHaveBeenCalledWith(msg);
    expect(handlerA).not.toHaveBeenCalled();
  });

  it('broadcasts messages (toAgentId=null) to all except sender', () => {
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    const handlerC = vi.fn();
    bus.subscribe('agent-a', handlerA);
    bus.subscribe('agent-b', handlerB);
    bus.subscribe('agent-c', handlerC);

    const msg = makeMessage({ fromAgentId: 'agent-a', toAgentId: null });
    bus.publish(msg);

    expect(handlerA).not.toHaveBeenCalled(); // sender excluded
    expect(handlerB).toHaveBeenCalledWith(msg);
    expect(handlerC).toHaveBeenCalledWith(msg);
  });

  it('does not deliver after unsubscribe', () => {
    const handler = vi.fn();
    const sub = bus.subscribe('agent-a', handler);
    sub.dispose();

    bus.publish(makeMessage({ toAgentId: 'agent-a' }));
    expect(handler).not.toHaveBeenCalled();
  });

  // ─── Type Subscriptions ────────────────────────────────────────────

  it('notifies type-based subscribers regardless of target', () => {
    const typeHandler = vi.fn();
    bus.subscribeToType(MessageType.TaskCompleted, typeHandler);

    const msg = makeMessage({
      type: MessageType.TaskCompleted,
      toAgentId: 'agent-x',
    });
    bus.publish(msg);

    expect(typeHandler).toHaveBeenCalledWith(msg);
  });

  it('does not fire type subscribers for other types', () => {
    const typeHandler = vi.fn();
    bus.subscribeToType(MessageType.TaskCompleted, typeHandler);

    bus.publish(makeMessage({ type: MessageType.StatusUpdate }));
    expect(typeHandler).not.toHaveBeenCalled();
  });

  it('cleans up type subscriptions on dispose', () => {
    const typeHandler = vi.fn();
    const sub = bus.subscribeToType(MessageType.BlockerRaised, typeHandler);
    sub.dispose();

    bus.publish(makeMessage({ type: MessageType.BlockerRaised }));
    expect(typeHandler).not.toHaveBeenCalled();
  });

  // ─── Global Event ──────────────────────────────────────────────────

  it('fires the onMessage event for every published message', () => {
    const globalHandler = vi.fn();
    bus.onMessage(globalHandler);

    const msg = makeMessage();
    bus.publish(msg);

    expect(globalHandler).toHaveBeenCalledWith(msg);
  });

  // ─── History ───────────────────────────────────────────────────────

  it('stores messages in history', () => {
    bus.publish(makeMessage({ fromAgentId: 'a1' }));
    bus.publish(makeMessage({ fromAgentId: 'a2' }));

    expect(bus.getHistory()).toHaveLength(2);
  });

  it('filters history by agentId', () => {
    bus.publish(makeMessage({ fromAgentId: 'a1', toAgentId: null }));
    bus.publish(makeMessage({ fromAgentId: 'a2', toAgentId: 'a1' }));
    bus.publish(makeMessage({ fromAgentId: 'a3', toAgentId: 'a3' }));

    const filtered = bus.getHistory({ agentId: 'a1' });
    expect(filtered).toHaveLength(2); // sent by a1 + sent to a1
  });

  it('filters history by message type', () => {
    bus.publish(makeMessage({ type: MessageType.StatusUpdate }));
    bus.publish(makeMessage({ type: MessageType.TaskCompleted }));
    bus.publish(makeMessage({ type: MessageType.StatusUpdate }));

    const filtered = bus.getHistory({ type: MessageType.StatusUpdate });
    expect(filtered).toHaveLength(2);
  });

  it('limits history results', () => {
    for (let i = 0; i < 10; i++) {
      bus.publish(makeMessage());
    }

    const limited = bus.getHistory({ limit: 3 });
    expect(limited).toHaveLength(3);
  });

  it('caps history at maxHistorySize (1000)', () => {
    for (let i = 0; i < 1050; i++) {
      bus.publish(makeMessage({ id: `msg-${i}` }));
    }

    expect(bus.getHistory()).toHaveLength(1000);
  });

  it('clears history', () => {
    bus.publish(makeMessage());
    bus.publish(makeMessage());
    bus.clear();

    expect(bus.getHistory()).toHaveLength(0);
  });

  // ─── Dispose ───────────────────────────────────────────────────────

  it('dispose clears everything', () => {
    const handler = vi.fn();
    bus.subscribe('agent-a', handler);
    bus.publish(makeMessage());

    bus.dispose();

    expect(bus.getHistory()).toHaveLength(0);
    // After dispose, publishing should not throw but won't route
    // (subscribers were cleared)
  });
});
