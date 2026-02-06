import type { AgentSpawner, SpawnTask, SpawnerConfig } from '../shared/types.js';

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
 * Placeholder implementation; real integration requires @anthropic-ai/claude-agent-sdk.
 */
export class AgentSdkSpawner implements AgentSpawner {
  async spawn(task: SpawnTask): Promise<void> {
    // TODO: Integrate with @anthropic-ai/claude-agent-sdk when available
    console.log(`[SPAWN:SDK] Would spawn agent ${task.agentConfig.id} via Agent SDK`);
    console.log(`[SPAWN:SDK] Model: ${task.agentConfig.model ?? 'default'}`);
    console.log(`[SPAWN:SDK] Session: ${task.sessionId}`);
    throw new Error(
      'AgentSdkSpawner is not yet implemented. Install @anthropic-ai/claude-agent-sdk and implement the spawn method.',
    );
  }
}

/**
 * Create a spawner instance based on config.
 */
export function createSpawner(config: SpawnerConfig): AgentSpawner {
  switch (config.type) {
    case 'log':
      return new LogWebhookSpawner();
    case 'webhook':
      return new LogWebhookSpawner({ webhookUrl: config.webhook_url });
    case 'sdk':
      return new AgentSdkSpawner();
    default:
      return new LogWebhookSpawner();
  }
}
