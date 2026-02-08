import type { AgentSpawner, AgentConfig, AgentLifecycleEvent, SpawnTask, SpawnerConfig } from '../shared/types.js';
import type { AgentRegistry } from './agent-registry.js';

/**
 * LogWebhookSpawner - Development/testing spawner.
 * Logs spawn requests and optionally POSTs to a webhook URL.
 */
export class LogWebhookSpawner implements AgentSpawner {
  private webhookUrl?: string;

  constructor(opts?: { webhookUrl?: string }) {
    this.webhookUrl = opts?.webhookUrl;
  }

  async spawn(task: SpawnTask): Promise<void> {
    console.log(`[SPAWN] Agent ${task.agentConfig.id} (${task.agentConfig.name}) for session ${task.sessionId}`);
    console.log(`[SPAWN] Role: ${task.agentConfig.role}`);
    console.log(`[SPAWN] Mode: ${task.connectionMode ?? 'per_session'}`);
    console.log(`[SPAWN] Context: ${task.context.substring(0, 200)}${task.context.length > 200 ? '...' : ''}`);
    console.log(`[SPAWN] MCP URL: ${task.councilMcpUrl}`);
    console.log(`[SPAWN] Token: ${task.agentToken}`);

    if (this.webhookUrl) {
      try {
        await fetch(this.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(task),
        });
      } catch (err) {
        console.error(`[SPAWN] Webhook POST failed: ${(err as Error).message}`);
      }
    }
  }
}

/**
 * AgentSdkSpawner - Production spawner using Claude Agent SDK.
 * Uses @anthropic-ai/claude-agent-sdk query() to launch autonomous agents
 * that connect back to Council via MCP HTTP transport.
 */

interface AgentSdkSpawnerOptions {
  registry: AgentRegistry;
  defaultModel?: string;
  maxTurns?: number;
  timeoutMs?: number;
  onLifecycleEvent?: (event: AgentLifecycleEvent) => void;
}

interface PendingAssignment {
  task: SpawnTask;
  resolve: () => void;
}

export class AgentSdkSpawner implements AgentSpawner {
  private registry: AgentRegistry;
  private defaultModel: string;
  private maxTurns: number;
  private timeoutMs: number;
  private onLifecycleEvent?: (event: AgentLifecycleEvent) => void;
  private sdkAvailable: boolean | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queryFn: ((...args: any[]) => AsyncIterable<any>) | null = null;
  // Per-agent assignment queues for persistent agents
  private assignmentQueues = new Map<string, PendingAssignment[]>();
  private persistentAgentRunning = new Set<string>();

  constructor(opts: AgentSdkSpawnerOptions) {
    this.registry = opts.registry;
    this.defaultModel = opts.defaultModel ?? 'claude-sonnet-4-5-20250929';
    this.maxTurns = opts.maxTurns ?? 100;
    this.timeoutMs = opts.timeoutMs ?? 300_000; // 5 minutes
    this.onLifecycleEvent = opts.onLifecycleEvent;
  }

  private async ensureSdk(): Promise<boolean> {
    if (this.sdkAvailable !== null) return this.sdkAvailable;

    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      this.queryFn = sdk.query;
      this.sdkAvailable = true;
      return true;
    } catch {
      console.error(
        '[SPAWN:SDK] @anthropic-ai/claude-agent-sdk is not installed. '
        + 'Run: pnpm add @anthropic-ai/claude-agent-sdk',
      );
      this.sdkAvailable = false;
      return false;
    }
  }

  async spawn(task: SpawnTask): Promise<void> {
    const available = await this.ensureSdk();
    if (!available) {
      console.warn(
        `[SPAWN:SDK] Falling back to log-only mode for agent ${task.agentConfig.id}. `
        + 'Install the SDK for production use.',
      );
      console.log(`[SPAWN:SDK:FALLBACK] Agent ${task.agentConfig.id} for session ${task.sessionId}`);
      console.log(`[SPAWN:SDK:FALLBACK] Mode: ${task.connectionMode ?? 'per_session'}`);
      console.log(`[SPAWN:SDK:FALLBACK] MCP URL: ${task.councilMcpUrl}`);
      console.log(`[SPAWN:SDK:FALLBACK] Token: ${task.agentToken}`);
      return;
    }

    // For persistent agents already running, enqueue instead of launching a new process
    if (task.connectionMode === 'persistent' && this.persistentAgentRunning.has(task.agentConfig.id)) {
      const queue = this.assignmentQueues.get(task.agentConfig.id) ?? [];
      const promise = new Promise<void>((resolve) => {
        queue.push({ task, resolve });
      });
      this.assignmentQueues.set(task.agentConfig.id, queue);
      await promise;
      return;
    }

    if (task.connectionMode === 'persistent') {
      // Start persistent agent loop (fire-and-forget)
      this.runPersistentAgent(task).catch((err) => {
        console.error(`[SPAWN:SDK] Persistent agent ${task.agentConfig.id} crashed: ${(err as Error).message}`);
      });
    } else {
      // Fire-and-forget: start the agent loop but don't await it
      this.runAgentWithRetry(task).catch((err) => {
        console.error(`[SPAWN:SDK] Agent ${task.agentConfig.id} crashed: ${(err as Error).message}`);
      });
    }
  }

  private async runAgentWithRetry(task: SpawnTask, maxRetries = 2): Promise<void> {
    let attempt = 0;
    while (attempt <= maxRetries) {
      try {
        await this.runAgent(task);
        return;
      } catch (err) {
        attempt++;
        const error = err as Error;

        // Don't retry budget or max-turn errors
        if (error.message.includes('max_turns') || error.message.includes('max_budget')) {
          console.error(`[SPAWN:SDK] Non-retryable error for ${task.agentConfig.id}: ${error.message}`);
          return;
        }

        if (attempt > maxRetries) {
          console.error(`[SPAWN:SDK] Agent ${task.agentConfig.id} failed after ${maxRetries} retries: ${error.message}`);
          return;
        }

        const backoffMs = 1000 * Math.pow(2, attempt - 1);
        console.warn(`[SPAWN:SDK] Retry ${attempt}/${maxRetries} for ${task.agentConfig.id} in ${backoffMs}ms`);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  private async runAgent(task: SpawnTask): Promise<void> {
    const { agentConfig, sessionId, context, councilMcpUrl, agentToken } = task;

    const systemPrompt = this.buildSystemPrompt(agentConfig, sessionId, agentToken, task.connectionMode);
    const prompt = this.buildInitialPrompt(agentConfig, sessionId, context);

    const mcpServers = {
      council: {
        type: 'http' as const,
        url: councilMcpUrl,
        headers: {
          'x-agent-token': agentToken,
        },
      },
    };

    this.emitLifecycle({ type: 'agent:started', agentId: agentConfig.id, sessionId });
    this.registry.connect(agentConfig.id);
    const startTime = Date.now();

    try {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), this.timeoutMs);

      try {
        for await (const message of this.queryFn!({
          prompt,
          options: {
            model: agentConfig.model ?? this.defaultModel,
            systemPrompt,
            maxTurns: this.maxTurns,
            mcpServers,
            allowedTools: ['mcp__council__*'],
            permissionMode: 'bypassPermissions',
            abortController,
          },
        }) as AsyncIterable<SdkMessage>) {
          this.registry.touch(agentConfig.id);

          if (message.type === 'result') {
            const duration = Date.now() - startTime;
            if (message.subtype === 'success') {
              this.emitLifecycle({
                type: 'agent:completed',
                agentId: agentConfig.id,
                sessionId,
                durationMs: duration,
                cost: message.total_cost_usd,
              });
            } else {
              const errorMsg = message.errors?.join('; ') ?? `Agent ended with: ${message.subtype}`;
              this.emitLifecycle({
                type: 'agent:errored',
                agentId: agentConfig.id,
                sessionId,
                error: errorMsg,
              });
            }
          }
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      const duration = Date.now() - startTime;
      this.emitLifecycle({
        type: 'agent:errored',
        agentId: agentConfig.id,
        sessionId,
        error: (err as Error).message,
      });
      // Re-throw for retry logic
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        throw err;
      }
      console.warn(`[SPAWN:SDK] Agent ${agentConfig.id} timed out after ${duration}ms`);
    } finally {
      this.registry.disconnect(agentConfig.id);
    }
  }

  private async runPersistentAgent(task: SpawnTask): Promise<void> {
    const agentId = task.agentConfig.id;
    this.persistentAgentRunning.add(agentId);
    this.assignmentQueues.set(agentId, []);

    try {
      // Process the initial session
      await this.runAgentForSession(task);

      // Loop: wait for and process subsequent assignments
      while (this.persistentAgentRunning.has(agentId)) {
        const queue = this.assignmentQueues.get(agentId) ?? [];
        if (queue.length === 0) {
          // Poll for new assignments
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }

        const next = queue.shift()!;
        try {
          await this.runAgentForSession(next.task);
        } finally {
          next.resolve();
        }
      }
    } finally {
      this.persistentAgentRunning.delete(agentId);
      this.assignmentQueues.delete(agentId);
      this.registry.disconnect(agentId);
    }
  }

  private async runAgentForSession(task: SpawnTask): Promise<void> {
    const { agentConfig, sessionId, context, councilMcpUrl, agentToken } = task;

    const systemPrompt = this.buildSystemPrompt(agentConfig, sessionId, agentToken, task.connectionMode);
    const prompt = this.buildInitialPrompt(agentConfig, sessionId, context);

    const mcpServers = {
      council: {
        type: 'http' as const,
        url: councilMcpUrl,
        headers: {
          'x-agent-token': agentToken,
        },
      },
    };

    this.emitLifecycle({ type: 'agent:started', agentId: agentConfig.id, sessionId });
    this.registry.connect(agentConfig.id);
    const startTime = Date.now();

    try {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), this.timeoutMs);

      try {
        for await (const message of this.queryFn!({
          prompt,
          options: {
            model: agentConfig.model ?? this.defaultModel,
            systemPrompt,
            maxTurns: this.maxTurns,
            mcpServers,
            allowedTools: ['mcp__council__*'],
            permissionMode: 'bypassPermissions',
            abortController,
          },
        }) as AsyncIterable<SdkMessage>) {
          this.registry.touch(agentConfig.id);

          if (message.type === 'result') {
            const duration = Date.now() - startTime;
            if (message.subtype === 'success') {
              this.emitLifecycle({
                type: 'agent:completed',
                agentId: agentConfig.id,
                sessionId,
                durationMs: duration,
                cost: message.total_cost_usd,
              });
            } else {
              const errorMsg = message.errors?.join('; ') ?? `Agent ended with: ${message.subtype}`;
              this.emitLifecycle({
                type: 'agent:errored',
                agentId: agentConfig.id,
                sessionId,
                error: errorMsg,
              });
            }
          }
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      const duration = Date.now() - startTime;
      this.emitLifecycle({
        type: 'agent:errored',
        agentId: agentConfig.id,
        sessionId,
        error: (err as Error).message,
      });
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        throw err;
      }
      console.warn(`[SPAWN:SDK] Agent ${agentConfig.id} timed out after ${duration}ms`);
    }
    // Note: persistent agents do NOT disconnect after a single session
  }

  private buildSystemPrompt(agentConfig: AgentConfig, sessionId: string, agentToken: string, connectionMode?: 'per_session' | 'persistent'): string {
    const persistentInstructions = connectionMode === 'persistent' ? `

## Persistent Agent Mode
You are a persistent agent. After completing work on a session, you will receive new session
assignments automatically. Do NOT terminate after a single session. Use council_get_assignments
to check for new work.` : '';

    return `${agentConfig.system_prompt}

---

## Council Operating Instructions

You are participating in a council deliberation session (session: ${sessionId}).
Your role on this council is: ${agentConfig.role}
${agentConfig.expertise.length > 0 ? `Your areas of expertise: ${agentConfig.expertise.join(', ')}` : ''}

You have access to the Council MCP server with the following tools:
- council_get_context: Get your pending tasks and recent messages
- council_get_session: Get full details for a specific session
- council_send_message: Send a message to other council members
- council_consult_agent: Request input from another board member
- council_create_proposal: Create a formal proposal for deliberation
- council_submit_findings: Submit investigation results
- council_cast_vote: Vote on a proposal (approve/reject/abstain)
- council_list_sessions: List active sessions
- council_get_assignments: Get your current session assignments (persistent agents)

For ALL tool calls, use agent_token: "${agentToken}"

## Your workflow:
1. Start by calling council_get_context to understand what is needed
2. Review the session details with council_get_session
3. Investigate the matter and submit your findings
4. Discuss with other council members as needed
5. When in voting phase, cast your vote with clear reasoning

${agentConfig.can_veto ? 'You have VETO power. Use it only for critical issues.' : ''}
${agentConfig.can_propose ? 'You can create formal proposals.' : 'You cannot create proposals, but you can discuss and vote.'}${persistentInstructions}`;
  }

  private buildInitialPrompt(agentConfig: AgentConfig, sessionId: string, context: string): string {
    return `You have been activated for council session ${sessionId}.

Here is the context for this session:

${context}

Begin by calling council_get_context with your agent token to see your full briefing, then proceed according to your role as ${agentConfig.role}.`;
  }

  private emitLifecycle(event: AgentLifecycleEvent): void {
    console.log(`[SPAWN:SDK] ${event.type}: agent=${event.agentId} session=${event.sessionId}${
      event.type === 'agent:completed' ? ` duration=${event.durationMs}ms cost=$${event.cost ?? 'unknown'}` : ''
    }${event.type === 'agent:errored' ? ` error=${event.error}` : ''}`);
    this.onLifecycleEvent?.(event);
  }
}

/** Minimal type for SDK messages we care about. */
interface SdkMessage {
  type: string;
  subtype?: string;
  total_cost_usd?: number;
  errors?: string[];
}

/**
 * Create a spawner instance based on config.
 */
export function createSpawner(config: SpawnerConfig, registry?: AgentRegistry): AgentSpawner {
  switch (config.type) {
    case 'log':
      return new LogWebhookSpawner();
    case 'webhook':
      return new LogWebhookSpawner({ webhookUrl: config.webhook_url });
    case 'sdk':
      if (!registry) {
        throw new Error('AgentSdkSpawner requires an AgentRegistry instance');
      }
      return new AgentSdkSpawner({
        registry,
        defaultModel: config.default_model,
        maxTurns: config.max_turns,
        timeoutMs: config.timeout_ms,
      });
    default:
      return new LogWebhookSpawner();
  }
}
