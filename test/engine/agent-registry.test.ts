import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRegistry } from '@/engine/agent-registry.js';
import type { AgentConfig } from '@/shared/types.js';

const persistentAgent: AgentConfig = {
  id: 'persistent-bot',
  name: 'Persistent Bot',
  role: 'Watcher',
  expertise: [],
  can_propose: true,
  can_veto: false,
  voting_weight: 1,
  system_prompt: 'You are a persistent bot.',
  persistent: true,
};

const ephemeralAgent: AgentConfig = {
  id: 'ephemeral-bot',
  name: 'Ephemeral Bot',
  role: 'Worker',
  expertise: [],
  can_propose: true,
  can_veto: false,
  voting_weight: 1,
  system_prompt: 'You are an ephemeral bot.',
};

describe('AgentRegistry — persistent agent support', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
    registry.loadAgents([persistentAgent, ephemeralAgent]);
  });

  describe('isPersistent', () => {
    it('returns true for agents with persistent: true', () => {
      expect(registry.isPersistent('persistent-bot')).toBe(true);
    });

    it('returns false for agents without persistent flag', () => {
      expect(registry.isPersistent('ephemeral-bot')).toBe(false);
    });

    it('returns false for unknown agents', () => {
      expect(registry.isPersistent('unknown')).toBe(false);
    });
  });

  describe('generatePersistentToken', () => {
    it('generates a token prefixed with council_persistent_', () => {
      const token = registry.generatePersistentToken('persistent-bot');
      expect(token).toMatch(/^council_persistent_persistent-bot_/);
    });

    it('returns the same token on repeated calls (idempotent)', () => {
      const token1 = registry.generatePersistentToken('persistent-bot');
      const token2 = registry.generatePersistentToken('persistent-bot');
      expect(token1).toBe(token2);
    });

    it('throws for unknown agent', () => {
      expect(() => registry.generatePersistentToken('unknown')).toThrow('Unknown agent');
    });
  });

  describe('generateToken for persistent agents', () => {
    it('returns the persistent token for persistent agents', () => {
      const token = registry.generateToken('persistent-bot');
      expect(token).toMatch(/^council_persistent_/);
    });

    it('returns the same persistent token on repeated calls', () => {
      const token1 = registry.generateToken('persistent-bot');
      const token2 = registry.generateToken('persistent-bot');
      expect(token1).toBe(token2);
    });
  });

  describe('generateToken for non-persistent agents', () => {
    it('returns a fresh token each time', () => {
      const token1 = registry.generateToken('ephemeral-bot');
      const token2 = registry.generateToken('ephemeral-bot');
      expect(token1).not.toBe(token2);
    });

    it('returns a token prefixed with council_ (not council_persistent_)', () => {
      const token = registry.generateToken('ephemeral-bot');
      expect(token).toMatch(/^council_ephemeral-bot_/);
      expect(token).not.toContain('persistent');
    });
  });

  describe('setPersistentToken / getPersistentToken', () => {
    it('sets and gets a persistent token', () => {
      registry.setPersistentToken('persistent-bot', 'my-token');
      expect(registry.getPersistentToken('persistent-bot')).toBe('my-token');
    });

    it('returns null for agents without a persistent token', () => {
      expect(registry.getPersistentToken('ephemeral-bot')).toBeNull();
    });
  });

  describe('resolveToken', () => {
    it('resolves per-session tokens', () => {
      const token = registry.generateToken('ephemeral-bot');
      expect(registry.resolveToken(token)).toBe('ephemeral-bot');
    });

    it('resolves persistent tokens', () => {
      const token = registry.generatePersistentToken('persistent-bot');
      expect(registry.resolveToken(token)).toBe('persistent-bot');
    });

    it('resolves tokens set via setPersistentToken', () => {
      registry.setPersistentToken('persistent-bot', 'loaded-from-db');
      expect(registry.resolveToken('loaded-from-db')).toBe('persistent-bot');
    });

    it('returns null for unknown tokens', () => {
      expect(registry.resolveToken('bogus')).toBeNull();
    });
  });

  describe('session tracking', () => {
    it('assigns and retrieves active sessions', () => {
      registry.assignSession('persistent-bot', 'session-1');
      registry.assignSession('persistent-bot', 'session-2');
      expect(registry.getActiveSessions('persistent-bot')).toEqual(
        expect.arrayContaining(['session-1', 'session-2']),
      );
    });

    it('unassigns sessions', () => {
      registry.assignSession('persistent-bot', 'session-1');
      registry.assignSession('persistent-bot', 'session-2');
      registry.unassignSession('persistent-bot', 'session-1');
      expect(registry.getActiveSessions('persistent-bot')).toEqual(['session-2']);
    });

    it('returns empty array for agents with no sessions', () => {
      expect(registry.getActiveSessions('ephemeral-bot')).toEqual([]);
    });

    it('handles duplicate assigns idempotently', () => {
      registry.assignSession('persistent-bot', 'session-1');
      registry.assignSession('persistent-bot', 'session-1');
      expect(registry.getActiveSessions('persistent-bot')).toEqual(['session-1']);
    });
  });

  describe('getStatuses', () => {
    it('includes connectionMode and activeSessions', () => {
      registry.assignSession('persistent-bot', 'session-1');
      const statuses = registry.getStatuses();
      const persistent = statuses.find((s) => s.id === 'persistent-bot');
      expect(persistent).toBeDefined();
      expect(persistent!.connectionMode).toBe('persistent');
      expect(persistent!.activeSessions).toEqual(['session-1']);

      const ephemeral = statuses.find((s) => s.id === 'ephemeral-bot');
      expect(ephemeral!.connectionMode).toBe('per_session');
      expect(ephemeral!.activeSessions).toEqual([]);
    });
  });

  describe('loadAgents initializes connectionMode', () => {
    it('sets persistent connection mode from config', () => {
      const statuses = registry.getStatuses();
      expect(statuses.find((s) => s.id === 'persistent-bot')!.connectionMode).toBe('persistent');
      expect(statuses.find((s) => s.id === 'ephemeral-bot')!.connectionMode).toBe('per_session');
    });
  });
});
