import { describe, it, expect, vi } from 'vitest';
import { MessageBus } from '@/engine/message-bus.js';
import type { Message, CommunicationGraph } from '@/shared/types.js';

function makeMsg(from: string, to: string | null): Message {
  return {
    id: `m-${from}-${to ?? 'all'}`,
    sessionId: 's1',
    fromAgentId: from,
    toAgentId: to,
    content: 'test',
    messageType: 'discussion',
    createdAt: '',
  };
}

describe('MessageBus (broadcast policy)', () => {
  const graph: CommunicationGraph = { default_policy: 'broadcast', edges: {} };

  it('delivers directed messages to the target', () => {
    const bus = new MessageBus(graph);
    const handler = vi.fn();
    bus.subscribe('b', handler);

    bus.publish(makeMsg('a', 'b'));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('delivers broadcast messages to all except sender', () => {
    const bus = new MessageBus(graph);
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    const handlerC = vi.fn();
    bus.subscribe('a', handlerA);
    bus.subscribe('b', handlerB);
    bus.subscribe('c', handlerC);

    bus.publish(makeMsg('a', null));
    expect(handlerA).not.toHaveBeenCalled();
    expect(handlerB).toHaveBeenCalledOnce();
    expect(handlerC).toHaveBeenCalledOnce();
  });

  it('notifies global handlers for all messages', () => {
    const bus = new MessageBus(graph);
    const globalHandler = vi.fn();
    bus.subscribeAll(globalHandler);

    bus.publish(makeMsg('a', 'b'));
    bus.publish(makeMsg('b', null));
    expect(globalHandler).toHaveBeenCalledTimes(2);
  });

  it('supports unsubscribe', () => {
    const bus = new MessageBus(graph);
    const handler = vi.fn();
    const unsub = bus.subscribe('b', handler);

    bus.publish(makeMsg('a', 'b'));
    expect(handler).toHaveBeenCalledOnce();

    unsub();
    bus.publish(makeMsg('a', 'b'));
    expect(handler).toHaveBeenCalledOnce(); // Still 1, not 2
  });
});

describe('MessageBus (graph policy)', () => {
  const graph: CommunicationGraph = {
    default_policy: 'graph',
    edges: {
      a: ['b'],       // a can talk to b
      b: ['a', 'c'],  // b can talk to a and c
    },
  };

  it('allows messages along graph edges', () => {
    const bus = new MessageBus(graph);
    const handler = vi.fn();
    bus.subscribe('b', handler);

    bus.publish(makeMsg('a', 'b'));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('blocks messages not in graph edges', () => {
    const bus = new MessageBus(graph);
    const handler = vi.fn();
    bus.subscribe('c', handler);

    // a -> c has no edge
    bus.publish(makeMsg('a', 'c'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('broadcasts only to allowed edges', () => {
    const bus = new MessageBus(graph);
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    const handlerC = vi.fn();
    bus.subscribe('a', handlerA);
    bus.subscribe('b', handlerB);
    bus.subscribe('c', handlerC);

    // a can only talk to b
    bus.publish(makeMsg('a', null));
    expect(handlerB).toHaveBeenCalledOnce();
    expect(handlerC).not.toHaveBeenCalled();
  });
});
