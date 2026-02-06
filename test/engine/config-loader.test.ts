import { describe, it, expect } from 'vitest';
import { parseConfig, ConfigLoadError } from '@/engine/config-loader.js';

const validYaml = `
version: "1"
council:
  name: "Test Council"
  description: "A test council"
  spawner:
    type: log
  rules:
    quorum: 2
    voting_threshold: 0.5
    max_deliberation_rounds: 3
    require_human_approval: true
  agents:
    - id: agent-a
      name: "Agent A"
      role: "Tester"
      expertise: [testing]
      system_prompt: "You are Agent A."
    - id: agent-b
      name: "Agent B"
      role: "Reviewer"
      expertise: [review]
      system_prompt: "You are Agent B."
  communication_graph:
    default_policy: broadcast
    edges: {}
  event_routing:
    - match:
        source: github
        type: issues.opened
        labels: [bug]
      assign:
        lead: agent-a
        consult: [agent-b]
`;

describe('parseConfig', () => {
  it('parses valid YAML config', () => {
    const config = parseConfig(validYaml);
    expect(config.version).toBe('1');
    expect(config.council.name).toBe('Test Council');
    expect(config.council.agents).toHaveLength(2);
    expect(config.council.agents[0].id).toBe('agent-a');
    expect(config.council.rules.quorum).toBe(2);
  });

  it('applies defaults', () => {
    const minimal = `
version: "1"
council:
  name: "Minimal"
  rules:
    quorum: 1
    voting_threshold: 0.5
  agents:
    - id: dev
      name: "Dev"
      role: "Developer"
      system_prompt: "You are a dev."
`;
    const config = parseConfig(minimal);
    expect(config.council.spawner.type).toBe('log');
    expect(config.council.rules.max_deliberation_rounds).toBe(5);
    expect(config.council.rules.require_human_approval).toBe(true);
    expect(config.council.agents[0].can_propose).toBe(true);
    expect(config.council.agents[0].can_veto).toBe(false);
    expect(config.council.agents[0].voting_weight).toBe(1);
    expect(config.council.communication_graph.default_policy).toBe('broadcast');
  });

  it('rejects invalid YAML', () => {
    expect(() => parseConfig('not: valid: yaml: [')).toThrow(ConfigLoadError);
  });

  it('rejects missing required fields', () => {
    const missing = `
version: "1"
council:
  name: "No agents"
  rules:
    quorum: 1
    voting_threshold: 0.5
  agents: []
`;
    expect(() => parseConfig(missing)).toThrow(ConfigLoadError);
  });

  it('rejects wrong version', () => {
    const wrong = `
version: "2"
council:
  name: "Test"
  rules:
    quorum: 1
    voting_threshold: 0.5
  agents:
    - id: dev
      name: "Dev"
      role: "Dev"
      system_prompt: "dev"
`;
    expect(() => parseConfig(wrong)).toThrow(ConfigLoadError);
  });

  it('rejects invalid agent ID format', () => {
    const bad = `
version: "1"
council:
  name: "Test"
  rules:
    quorum: 1
    voting_threshold: 0.5
  agents:
    - id: "Agent With Spaces"
      name: "Bad"
      role: "Bad"
      system_prompt: "bad"
`;
    expect(() => parseConfig(bad)).toThrow(ConfigLoadError);
  });

  it('detects invalid agent references in event routing', () => {
    const badRef = `
version: "1"
council:
  name: "Test"
  rules:
    quorum: 1
    voting_threshold: 0.5
  agents:
    - id: dev
      name: "Dev"
      role: "Dev"
      system_prompt: "dev"
  event_routing:
    - match:
        source: github
      assign:
        lead: nonexistent
        consult: []
`;
    expect(() => parseConfig(badRef)).toThrow(ConfigLoadError);
  });

  it('resolves environment variables', () => {
    process.env.TEST_SECRET = 'my-secret';
    const yaml = `
version: "1"
council:
  name: "Test"
  rules:
    quorum: 1
    voting_threshold: 0.5
  agents:
    - id: dev
      name: "Dev"
      role: "Dev"
      system_prompt: "dev"
  github:
    webhook_secret: "\${TEST_SECRET}"
    repos: []
`;
    const config = parseConfig(yaml);
    expect(config.council.github?.webhook_secret).toBe('my-secret');
    delete process.env.TEST_SECRET;
  });
});
