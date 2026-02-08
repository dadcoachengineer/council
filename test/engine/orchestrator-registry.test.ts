import { describe, it, expect, beforeEach } from 'vitest';
import { OrchestratorRegistry } from '@/engine/orchestrator-registry.js';
import { parseConfig } from '@/engine/config-loader.js';
import type { OrchestratorStore } from '@/engine/orchestrator.js';
import type { Session, Message, Vote, Decision, IncomingEvent, EscalationEvent, SessionPhase } from '@/shared/types.js';

const YAML_A = `
version: "1"
council:
  name: "Council A"
  description: "First council"
  spawner:
    type: log
  rules:
    quorum: 1
    voting_threshold: 0.5
    max_deliberation_rounds: 3
    require_human_approval: false
    escalation: []
  agents:
    - id: agent-a
      name: "Agent A"
      role: "Lead"
      system_prompt: "You are agent A."
  event_routing: []
  communication_graph:
    default_policy: broadcast
    edges: {}
`;

const YAML_B = `
version: "1"
council:
  name: "Council B"
  description: "Second council"
  spawner:
    type: log
  rules:
    quorum: 1
    voting_threshold: 0.5
    max_deliberation_rounds: 3
    require_human_approval: false
    escalation: []
  agents:
    - id: agent-b
      name: "Agent B"
      role: "Reviewer"
      system_prompt: "You are agent B."
  event_routing: []
  communication_graph:
    default_policy: broadcast
    edges: {}
`;

function createMockStore(): OrchestratorStore {
  const sessions = new Map<string, Session>();
  const messages = new Map<string, Message[]>();
  const voteStore = new Map<string, Vote[]>();
  const decisions = new Map<string, Decision>();
  const eventStore: IncomingEvent[] = [];
  const escalationStore = new Map<string, EscalationEvent[]>();
  const participants = new Map<string, Array<{ agentId: string; role: string }>>();

  return {
    saveSession: (s) => sessions.set(s.id, s),
    updateSession: (id, updates) => {
      const s = sessions.get(id);
      if (s) sessions.set(id, { ...s, ...updates });
    },
    getSession: (id) => sessions.get(id) ?? null,
    listSessions: (councilId?: string, phase?: SessionPhase) => {
      let all = Array.from(sessions.values());
      if (councilId) all = all.filter((s) => s.councilId === councilId);
      if (phase) all = all.filter((s) => s.phase === phase);
      return all;
    },
    saveMessage: (m) => {
      const list = messages.get(m.sessionId) ?? [];
      list.push(m);
      messages.set(m.sessionId, list);
    },
    updateMessage: () => {},
    getMessages: (sid) => [...(messages.get(sid) ?? [])],
    saveVote: (v) => {
      const list = voteStore.get(v.sessionId) ?? [];
      list.push(v);
      voteStore.set(v.sessionId, list);
    },
    getVotes: (sid) => [...(voteStore.get(sid) ?? [])],
    saveDecision: (d) => decisions.set(d.sessionId, d),
    getDecision: (sid) => decisions.get(sid) ?? null,
    updateDecision: () => {},
    listPendingDecisions: () => [],
    saveEvent: (e) => eventStore.push(e),
    listEvents: () => [...eventStore],
    saveEscalationEvent: (e) => {
      const list = escalationStore.get(e.sessionId) ?? [];
      list.push(e);
      escalationStore.set(e.sessionId, list);
    },
    getEscalationEvents: (sid) => [...(escalationStore.get(sid) ?? [])],
    addSessionParticipant: (sid, agentId, role) => {
      const list = participants.get(sid) ?? [];
      if (!list.some(p => p.agentId === agentId)) {
        list.push({ agentId, role });
        participants.set(sid, list);
      }
    },
    getSessionParticipants: (sid) => [...(participants.get(sid) ?? [])],
  };
}

describe('OrchestratorRegistry', () => {
  let registry: OrchestratorRegistry;
  let store: OrchestratorStore;

  beforeEach(() => {
    registry = new OrchestratorRegistry();
    store = createMockStore();
  });

  it('creates and registers a council', () => {
    const config = parseConfig(YAML_A);
    const entry = registry.create('council-a', config, store, 'http://localhost:0/mcp');

    expect(registry.size).toBe(1);
    expect(entry.orchestrator).toBeDefined();
    expect(entry.config.council.name).toBe('Council A');
    expect(entry.agentRegistry.getAgent('agent-a')).not.toBeNull();
  });

  it('first registered council becomes default', () => {
    const configA = parseConfig(YAML_A);
    const configB = parseConfig(YAML_B);

    registry.create('council-a', configA, store, 'http://localhost:0/mcp');
    registry.create('council-b', configB, store, 'http://localhost:0/mcp');

    expect(registry.getDefaultId()).toBe('council-a');
    expect(registry.getDefault()?.config.council.name).toBe('Council A');
  });

  it('gets entry by id', () => {
    const config = parseConfig(YAML_A);
    registry.create('council-a', config, store, 'http://localhost:0/mcp');

    expect(registry.get('council-a')).not.toBeNull();
    expect(registry.get('nonexistent')).toBeNull();
  });

  it('removes a council', () => {
    const configA = parseConfig(YAML_A);
    const configB = parseConfig(YAML_B);

    registry.create('council-a', configA, store, 'http://localhost:0/mcp');
    registry.create('council-b', configB, store, 'http://localhost:0/mcp');

    expect(registry.remove('council-a')).toBe(true);
    expect(registry.size).toBe(1);
    expect(registry.get('council-a')).toBeNull();
    // Default should switch to council-b
    expect(registry.getDefaultId()).toBe('council-b');
  });

  it('remove returns false for unknown council', () => {
    expect(registry.remove('nonexistent')).toBe(false);
  });

  it('lists all councils', () => {
    const configA = parseConfig(YAML_A);
    const configB = parseConfig(YAML_B);

    registry.create('council-a', configA, store, 'http://localhost:0/mcp');
    registry.create('council-b', configB, store, 'http://localhost:0/mcp');

    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list.map(l => l.councilId).sort()).toEqual(['council-a', 'council-b']);
  });

  it('resolves agent token across councils', () => {
    const configA = parseConfig(YAML_A);
    const configB = parseConfig(YAML_B);

    registry.create('council-a', configA, store, 'http://localhost:0/mcp');
    registry.create('council-b', configB, store, 'http://localhost:0/mcp');

    // Generate a token for agent-a in council-a
    const entryA = registry.get('council-a')!;
    const token = entryA.agentRegistry.generateToken('agent-a');

    const result = registry.resolveAgentToken(token);
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe('agent-a');
    expect(result!.councilId).toBe('council-a');
  });

  it('resolveAgentToken returns null for unknown token', () => {
    const config = parseConfig(YAML_A);
    registry.create('council-a', config, store, 'http://localhost:0/mcp');

    expect(registry.resolveAgentToken('fake_token')).toBeNull();
  });

  it('councils have independent sessions', () => {
    const configA = parseConfig(YAML_A);
    const configB = parseConfig(YAML_B);

    registry.create('council-a', configA, store, 'http://localhost:0/mcp');
    registry.create('council-b', configB, store, 'http://localhost:0/mcp');

    const orchA = registry.get('council-a')!.orchestrator;
    const orchB = registry.get('council-b')!.orchestrator;

    orchA.createSession({ title: 'Session in A' });
    orchB.createSession({ title: 'Session in B' });
    orchB.createSession({ title: 'Another in B' });

    expect(orchA.listSessions()).toHaveLength(1);
    expect(orchB.listSessions()).toHaveLength(2);
    expect(orchA.listSessions()[0].title).toBe('Session in A');
  });

  it('register allows adding pre-built entries', () => {
    const configA = parseConfig(YAML_A);
    const entry = registry.create('temp', configA, store, 'http://localhost:0/mcp');

    const registry2 = new OrchestratorRegistry();
    registry2.register('my-council', entry);
    expect(registry2.size).toBe(1);
    expect(registry2.getDefaultId()).toBe('my-council');
  });

  it('default is null when registry is empty', () => {
    expect(registry.getDefault()).toBeNull();
    expect(registry.getDefaultId()).toBeNull();
  });

  it('removing the only council clears the default', () => {
    const config = parseConfig(YAML_A);
    registry.create('council-a', config, store, 'http://localhost:0/mcp');
    registry.remove('council-a');

    expect(registry.getDefault()).toBeNull();
    expect(registry.getDefaultId()).toBeNull();
    expect(registry.size).toBe(0);
  });
});
