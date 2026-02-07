#!/usr/bin/env npx tsx
/**
 * manual-agent.ts — Standalone MCP client example
 *
 * Demonstrates the full agent lifecycle by:
 *   1. Starting a Council server in-process
 *   2. Creating a session and generating an agent token
 *   3. Connecting to the MCP endpoint with the SDK client
 *   4. Walking through: get context → submit findings → create proposal → cast vote
 *   5. Printing each step's result to stdout
 *
 * Run:
 *   npx tsx examples/manual-agent.ts
 *
 * To connect to an existing remote server instead, skip steps 1-2 and set:
 *   const MCP_URL = new URL('http://your-server:3000/mcp');
 *   const AGENT_TOKEN = 'council_<agentId>_<token>';  // from server logs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';

// Council internals — use relative imports since this is outside src/
import { parseConfig } from '../src/engine/config-loader.js';
import { createApp, type CouncilApp } from '../src/server/index.js';

// MCP SDK client
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ── Config ──────────────────────────────────────────────────────────

const CONFIG_YAML = `
version: "1"
council:
  name: "Example Council"
  description: "A two-agent council for the manual-agent demo"
  spawner:
    type: log
  rules:
    quorum: 2
    voting_threshold: 0.5
    max_deliberation_rounds: 3
    require_human_approval: true
  agents:
    - id: proposer
      name: "Proposer"
      role: "Proposal Author"
      can_propose: true
      system_prompt: "You draft proposals."
    - id: reviewer
      name: "Reviewer"
      role: "Reviewer"
      can_propose: false
      system_prompt: "You review proposals."
  event_routing: []
  communication_graph:
    default_policy: broadcast
`;

// ── Helpers ──────────────────────────────────────────────────────────

/** Extract the text content from an MCP tool result. */
function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  if ('content' in result && Array.isArray(result.content)) {
    const textItem = result.content.find(
      (c): c is { type: 'text'; text: string } => c.type === 'text',
    );
    return textItem?.text ?? '';
  }
  return JSON.stringify(result);
}

function banner(label: string): void {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(60));
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── 1. Start Council server ──

  banner('1. Starting Council server');

  const tmpDir = mkdtempSync(join(tmpdir(), 'council-example-'));
  const config = parseConfig(CONFIG_YAML);

  const council: CouncilApp = createApp({
    dbPath: join(tmpDir, 'example.db'),
    config,
    mcpBaseUrl: 'http://127.0.0.1:0/mcp', // placeholder, updated below
  });

  await new Promise<void>((resolve) => {
    council.httpServer.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = council.httpServer.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  console.log(`Server listening at ${baseUrl}`);

  // ── 2. Create a session and generate agent tokens ──

  banner('2. Creating session & generating agent tokens');

  const session = council.orchestrator.createSession({
    title: 'Demo: should we adopt TypeScript strict mode?',
    phase: 'investigation',
    leadAgentId: 'proposer',
  });
  console.log(`Session created: ${session.id} (phase: ${session.phase})`);

  const registry = council.orchestrator.getAgentRegistry();
  const proposerToken = registry.generateToken('proposer');
  const reviewerToken = registry.generateToken('reviewer');
  console.log(`Proposer token: ${proposerToken}`);
  console.log(`Reviewer token: ${reviewerToken}`);

  // ── 3. Connect MCP client (as the proposer agent) ──

  banner('3. Connecting MCP client as proposer');

  const mcpUrl = new URL(`${baseUrl}/mcp`);

  const proposerTransport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: {
      headers: { 'x-agent-token': proposerToken },
    },
  });

  const proposerClient = new Client({
    name: 'proposer-agent',
    version: '1.0.0',
  });
  await proposerClient.connect(proposerTransport);
  console.log('Proposer connected to MCP endpoint');

  // List available tools
  const { tools } = await proposerClient.listTools();
  console.log(`Available tools: ${tools.map((t) => t.name).join(', ')}`);

  // ── 4. Get context ──

  banner('4. council_get_context');

  const contextResult = await proposerClient.callTool({
    name: 'council_get_context',
    arguments: { agent_token: proposerToken },
  });
  console.log(resultText(contextResult));

  // ── 5. Submit findings ──

  banner('5. council_submit_findings');

  const findingsResult = await proposerClient.callTool({
    name: 'council_submit_findings',
    arguments: {
      agent_token: proposerToken,
      session_id: session.id,
      findings:
        'Investigated the codebase: 47 implicit `any` types found. ' +
        'Enabling strict mode would catch 12 potential null-reference bugs. ' +
        'Estimated effort: 2 days of type annotation work.',
    },
  });
  console.log(resultText(findingsResult));

  // ── 6. Create proposal (auto-transitions investigation → proposal → discussion) ──

  banner('6. council_create_proposal');

  const proposalResult = await proposerClient.callTool({
    name: 'council_create_proposal',
    arguments: {
      agent_token: proposerToken,
      session_id: session.id,
      proposal:
        'Enable TypeScript strict mode in tsconfig.json. ' +
        'Fix all 47 implicit-any errors and add null checks. ' +
        'Timeline: 2 days, starting next sprint.',
    },
  });
  console.log(resultText(proposalResult));

  // ── 7. Transition to voting and cast votes ──

  banner('7. Transition to voting & cast votes');

  // Transition session to voting phase (normally happens via discussion flow)
  council.orchestrator.transitionPhase(session.id, 'voting');
  console.log('Session transitioned to voting phase');

  // Proposer votes
  const proposerVote = await proposerClient.callTool({
    name: 'council_cast_vote',
    arguments: {
      agent_token: proposerToken,
      session_id: session.id,
      vote: 'approve',
      reasoning: 'Strict mode will prevent bugs and improve code quality.',
    },
  });
  console.log(`Proposer vote: ${resultText(proposerVote)}`);

  // Connect a second MCP client as the reviewer
  const reviewerTransport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: {
      headers: { 'x-agent-token': reviewerToken },
    },
  });

  const reviewerClient = new Client({
    name: 'reviewer-agent',
    version: '1.0.0',
  });
  await reviewerClient.connect(reviewerTransport);
  console.log('Reviewer connected to MCP endpoint');

  // Reviewer votes
  const reviewerVote = await reviewerClient.callTool({
    name: 'council_cast_vote',
    arguments: {
      agent_token: reviewerToken,
      session_id: session.id,
      vote: 'approve',
      reasoning: 'The analysis is thorough and the timeline is reasonable.',
    },
  });
  console.log(`Reviewer vote: ${resultText(reviewerVote)}`);

  // ── 8. Human review (approve the decision) ──

  banner('8. Human review');

  // With require_human_approval: true, quorum triggers voting → review.
  // A human (or script) must approve or reject the decision.
  council.orchestrator.submitReview(session.id, 'approve', 'demo-human', 'Looks good, ship it!');
  const reviewed = council.orchestrator.getSession(session.id);
  console.log(`Session phase after review: ${reviewed!.phase}`);

  // ── 9. Get final session state ──

  banner('9. council_get_session (final state)');

  const sessionResult = await proposerClient.callTool({
    name: 'council_get_session',
    arguments: {
      agent_token: proposerToken,
      session_id: session.id,
    },
  });

  // Pretty-print the final state
  const finalState = JSON.parse(resultText(sessionResult));
  console.log(`Phase: ${finalState.session.phase}`);
  console.log(`Messages: ${finalState.messages.length}`);
  console.log(`Votes: ${finalState.votes.length}`);
  if (finalState.decision) {
    console.log(`Decision: ${finalState.decision.outcome}`);
    console.log(`Summary: ${finalState.decision.summary}`);
  }

  // ── 10. Cleanup ──

  banner('10. Cleanup');

  await proposerTransport.terminateSession();
  await reviewerTransport.terminateSession();
  await proposerClient.close();
  await reviewerClient.close();
  console.log('MCP sessions closed');

  await council.close();
  rmSync(tmpDir, { recursive: true, force: true });
  console.log('Server shut down, temp files removed');

  console.log('\nDone! The full agent lifecycle completed successfully.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
