import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LogWebhookSpawner, AgentSdkSpawner, createSpawner } from '@/engine/spawner.js';
import { AgentRegistry } from '@/engine/agent-registry.js';
import type { SpawnTask, AgentConfig, AgentLifecycleEvent } from '@/shared/types.js';

// Mock the SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

const { query: mockQuery } = await import('@anthropic-ai/claude-agent-sdk');
const mockedQuery = vi.mocked(mockQuery);

const agentConfig: AgentConfig = {
  id: 'test-agent',
  name: 'Test Agent',
  role: 'Tester',
  expertise: ['testing', 'qa'],
  can_propose: true,
  can_veto: false,
  voting_weight: 1,
  system_prompt: 'You are a test agent.',
};

const task: SpawnTask = {
  sessionId: 'session-123',
  agentConfig,
  context: 'Test context for this session',
  councilMcpUrl: 'http://localhost:3000/mcp',
  agentToken: 'council_test-agent_abc123',
};

describe('LogWebhookSpawner', () => {
  it('logs spawn details to console', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const spawner = new LogWebhookSpawner();
    await spawner.spawn(task);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[SPAWN] Agent test-agent'));
    logSpy.mockRestore();
  });

  it('calls webhook URL when configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const spawner = new LogWebhookSpawner({ webhookUrl: 'http://example.com/hook' });
    await spawner.spawn(task);
    expect(fetchSpy).toHaveBeenCalledWith('http://example.com/hook', expect.objectContaining({
      method: 'POST',
    }));
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });
});

describe('AgentSdkSpawner', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
    registry.loadAgents([agentConfig]);
    vi.clearAllMocks();
  });

  it('calls query with correct MCP server config', async () => {
    async function* mockGenerator() {
      yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 };
    }
    mockedQuery.mockReturnValue(mockGenerator() as any);

    const spawner = new AgentSdkSpawner({ registry });
    await spawner.spawn(task);
    // Allow background task to complete
    await new Promise((r) => setTimeout(r, 100));

    expect(mockedQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('session-123'),
        options: expect.objectContaining({
          mcpServers: {
            council: {
              type: 'http',
              url: 'http://localhost:3000/mcp',
              headers: { 'x-agent-token': 'council_test-agent_abc123' },
            },
          },
          allowedTools: ['mcp__council__*'],
          permissionMode: 'bypassPermissions',
        }),
      }),
    );
  });

  it('includes agent system prompt and token', async () => {
    async function* mockGenerator() {
      yield { type: 'result', subtype: 'success', result: 'done' };
    }
    mockedQuery.mockReturnValue(mockGenerator() as any);

    const spawner = new AgentSdkSpawner({ registry });
    await spawner.spawn(task);
    await new Promise((r) => setTimeout(r, 100));

    const callArgs = mockedQuery.mock.calls[0][0] as any;
    expect(callArgs.options.systemPrompt).toContain('You are a test agent.');
    expect(callArgs.options.systemPrompt).toContain('council_test-agent_abc123');
    expect(callArgs.options.systemPrompt).toContain('testing, qa');
  });

  it('uses custom model from agent config', async () => {
    async function* mockGenerator() {
      yield { type: 'result', subtype: 'success', result: 'done' };
    }
    mockedQuery.mockReturnValue(mockGenerator() as any);

    const customTask = {
      ...task,
      agentConfig: { ...agentConfig, model: 'claude-opus-4-6' },
    };
    const spawner = new AgentSdkSpawner({ registry });
    await spawner.spawn(customTask);
    await new Promise((r) => setTimeout(r, 100));

    const callArgs = mockedQuery.mock.calls[0][0] as any;
    expect(callArgs.options.model).toBe('claude-opus-4-6');
  });

  it('emits lifecycle events', async () => {
    const events: AgentLifecycleEvent[] = [];
    async function* mockGenerator() {
      yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.05 };
    }
    mockedQuery.mockReturnValue(mockGenerator() as any);

    const spawner = new AgentSdkSpawner({
      registry,
      onLifecycleEvent: (e) => events.push(e),
    });
    await spawner.spawn(task);
    await new Promise((r) => setTimeout(r, 150));

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'agent:started', agentId: 'test-agent' }),
        expect.objectContaining({ type: 'agent:completed', agentId: 'test-agent' }),
      ]),
    );
  });

  it('tracks agent connection in registry', async () => {
    let resolveInner: () => void;
    const innerDone = new Promise<void>((r) => { resolveInner = r; });

    async function* mockGenerator() {
      // Yield something to keep the generator alive briefly
      yield { type: 'progress', text: 'working' };
      yield { type: 'result', subtype: 'success', result: 'done' };
      resolveInner!();
    }
    mockedQuery.mockReturnValue(mockGenerator() as any);

    const spawner = new AgentSdkSpawner({ registry });
    await spawner.spawn(task);

    // Wait for background task to complete
    await innerDone;
    await new Promise((r) => setTimeout(r, 50));

    // Agent should be disconnected after completion
    expect(registry.isConnected('test-agent')).toBe(false);
  });

  it('handles SDK errors gracefully (fire-and-forget)', async () => {
    mockedQuery.mockImplementation(() => {
      throw new Error('SDK initialization failed');
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const spawner = new AgentSdkSpawner({ registry });
    // spawn() should not throw — it's fire-and-forget
    await expect(spawner.spawn(task)).resolves.toBeUndefined();

    // Wait for retries to exhaust
    await new Promise((r) => setTimeout(r, 5000));

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  }, 10000);

  it('emits errored lifecycle on SDK failure', async () => {
    const events: AgentLifecycleEvent[] = [];
    async function* mockGenerator() {
      yield { type: 'result', subtype: 'error_during_execution', errors: ['Something went wrong'] };
    }
    mockedQuery.mockReturnValue(mockGenerator() as any);

    const spawner = new AgentSdkSpawner({
      registry,
      onLifecycleEvent: (e) => events.push(e),
    });
    await spawner.spawn(task);
    await new Promise((r) => setTimeout(r, 150));

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'agent:errored', agentId: 'test-agent' }),
      ]),
    );
  });
});

describe('createSpawner', () => {
  it('creates LogWebhookSpawner for type "log"', () => {
    const spawner = createSpawner({ type: 'log' });
    expect(spawner).toBeInstanceOf(LogWebhookSpawner);
  });

  it('creates LogWebhookSpawner with URL for type "webhook"', () => {
    const spawner = createSpawner({ type: 'webhook', webhook_url: 'http://example.com' });
    expect(spawner).toBeInstanceOf(LogWebhookSpawner);
  });

  it('creates AgentSdkSpawner for type "sdk" with registry', () => {
    const registry = new AgentRegistry();
    const spawner = createSpawner({ type: 'sdk' }, registry);
    expect(spawner).toBeInstanceOf(AgentSdkSpawner);
  });

  it('throws if type "sdk" without registry', () => {
    expect(() => createSpawner({ type: 'sdk' })).toThrow('AgentSdkSpawner requires an AgentRegistry');
  });

  it('passes SDK config options through', () => {
    const registry = new AgentRegistry();
    const spawner = createSpawner({
      type: 'sdk',
      default_model: 'claude-opus-4-6',
      max_turns: 50,
      timeout_ms: 60000,
    }, registry);
    expect(spawner).toBeInstanceOf(AgentSdkSpawner);
  });

  it('defaults to LogWebhookSpawner for unknown type', () => {
    const spawner = createSpawner({ type: 'unknown' as any });
    expect(spawner).toBeInstanceOf(LogWebhookSpawner);
  });
});
