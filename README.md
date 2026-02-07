# Council

Multi-agent MCP orchestrator modeled as a corporate governance board. Council is the central hub that orchestrates deliberation between AI agents (CTO, CPO, Legal, Finance, etc.) who connect as external Claude Code / Cowork agents over MCP.

## How it works

1. **Events come in** via GitHub webhooks or generic webhooks
2. **Council routes** the event to the right agent(s) based on YAML config rules
3. **Agents investigate** autonomously, consult each other through Council's MCP tools
4. **Proposals are made** and discussed over multiple rounds
5. **Proposals are refined** — agents propose amendments, the lead accepts or rejects them
6. **Agents vote** using configurable voting schemes (weighted majority, unanimous, supermajority, consent-based, or advisory)
7. **Escalation rules fire** automatically on deadlocks, timeouts, vetoes, or quorum failures
8. **Humans review** the final decision in the web UI

Agents never talk directly to each other. All communication flows through Council, which enforces a communication graph, persists all state, and drives the deliberation state machine.

## Quick start

### Prerequisites

- Node.js 22+
- pnpm

### Install and run

```bash
pnpm install
pnpm dev
```

The server starts on `http://localhost:3000` with a default development config.

### Run with a config file

```bash
CONFIG_PATH=config/examples/board-of-directors.yaml pnpm dev
```

### Run tests

```bash
pnpm test
```

### Build for production

```bash
pnpm build
pnpm start
```

### Docker

```bash
cd docker
docker compose up --build
```

## Configuration

Council is configured via YAML. See [config/examples/board-of-directors.yaml](config/examples/board-of-directors.yaml) for a full example.

Key sections:

| Section | Purpose |
|---------|---------|
| `council.agents` | Agent personas with roles, expertise, voting weights, veto power, and system prompts |
| `council.rules` | Quorum, voting threshold, max rounds, human approval, voting scheme, refinement settings |
| `council.rules.escalation` | Escalation rules: triggers (deadlock, timeout, veto, quorum, max rounds) and actions (escalate, restart, auto-decide, add agent, notify) |
| `council.event_routing` | Map incoming events to lead/consult agents by source, type, and labels |
| `council.communication_graph` | Control which agents can message each other (broadcast or graph) |
| `council.spawner` | How agents are launched: `log` (dev), `webhook`, or `sdk` (production) |

## Architecture

```
External Events → Webhook Ingestion → Event Router → Agent Spawner
                                                  ↓
                    MCP Server ← External Agents (Claude Code/Cowork)
                        ↓
                   Orchestrator (state machine)
                        ↓
              Message Bus / Voting / Decisions
                        ↓
              Web UI (human review) + REST API + WebSocket
```

### Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /webhooks/github` | GitHub webhook receiver |
| `POST /webhooks/ingest` | Generic webhook receiver |
| `/mcp` (POST/GET/DELETE) | MCP Streamable HTTP for agent connections |
| `GET /api/sessions` | List deliberation sessions |
| `GET /api/sessions/:id` | Get session with messages, votes, decision |
| `POST /api/sessions` | Create manual session |
| `POST /api/sessions/:id/review` | Submit human review |
| `GET /api/events` | List incoming events |
| `GET /api/agents` | List agent statuses |
| `GET /api/decisions` | List pending decisions |
| `ws://host/ws` | WebSocket for real-time UI updates |

### MCP Tools (agent-facing)

| Tool | Description |
|------|-------------|
| `council_get_context` | Get pending tasks, messages, and sessions |
| `council_get_session` | Get full session details |
| `council_send_message` | Send message to agent or broadcast |
| `council_consult_agent` | Request input from another board member |
| `council_create_proposal` | Create a formal proposal |
| `council_submit_findings` | Submit investigation results |
| `council_cast_vote` | Vote approve/reject/abstain with reasoning (values depend on voting scheme) |
| `council_list_sessions` | List sessions with optional filters |
| `council_list_councils` | List available councils |
| `council_propose_amendment` | Propose an amendment to the active proposal during refinement |
| `council_resolve_amendment` | Accept or reject a proposed amendment (lead agent only) |
| `council_get_voting_info` | Get the voting scheme and valid vote values for a council |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Server host |
| `DB_PATH` | `./data/council.db` | SQLite database path |
| `CONFIG_PATH` | (none) | Path to council YAML config |
| `MCP_BASE_URL` | `http://localhost:3000/mcp` | URL agents use to connect back |
| `COUNCIL_PASSWORD` | (none) | Password for web UI authentication (disabled if unset) |
| `GITHUB_WEBHOOK_SECRET` | (none) | GitHub webhook HMAC secret |

## Agent spawner modes

| Mode | Config | Use case |
|------|--------|----------|
| `log` | `spawner.type: log` | Development - logs spawn requests, connect agents manually |
| `webhook` | `spawner.type: webhook` | Posts spawn requests to a webhook URL |
| `sdk` | `spawner.type: sdk` | Production - uses Claude Agent SDK to spawn agents |

## Voting schemes

Configure `rules.voting_scheme` in YAML to change how votes are tallied. Defaults to `weighted_majority`.

| Scheme | Description |
|--------|-------------|
| `weighted_majority` | Weighted votes, passes if approval ratio >= threshold |
| `supermajority` | Requires a supermajority (preset: `two_thirds` or `three_quarters`, or custom `threshold`) |
| `unanimous` | All non-abstaining voters must approve |
| `consent_based` | Passes unless someone formally objects (vote values: consent/object/abstain) |
| `advisory` | Non-binding — always passes, results are informational |

## Escalation rules

Escalation rules in `rules.escalation` fire automatically when conditions are met during deliberation.

**Triggers**: `deadlock`, `quorum_not_met`, `veto_exercised`, `timeout` (with `timeout_seconds` and `phases`), `max_rounds_exceeded`

**Actions**: `escalate_to_human`, `restart_discussion`, `add_agent`, `auto_decide` (with `forced_outcome`), `notify_external` (with `webhook_url`)

Rules support `priority` ordering, `stop_after` to halt after first match, and `max_fires_per_session` to limit how many times a rule can fire.

## Refinement phase

When `rules.enable_refinement` is `true` (default), proposals enter a refinement phase after discussion where agents can propose amendments. The lead agent accepts or rejects each amendment before the proposal moves to voting.

Configure with `rules.max_amendments` (default: 10) and `rules.amendment_resolution` (`lead_resolves` or `auto_accept`).

## Schema migrations

The SQLite database automatically migrates on startup. When new columns are added in updates, `ALTER TABLE ADD COLUMN` migrations run after `CREATE TABLE IF NOT EXISTS`, using `PRAGMA table_info()` to detect missing columns. Existing data is preserved.

## Tech stack

- **Runtime**: Node.js 22+, TypeScript 5.7+
- **Server**: Express 5
- **Frontend**: Preact + Vite
- **Database**: SQLite (better-sqlite3 + Drizzle ORM)
- **MCP**: @modelcontextprotocol/sdk v1.26+
- **Testing**: Vitest

## License

MIT
