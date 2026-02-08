<p align="center">
  <h1 align="center">Council</h1>
  <p align="center">
    <strong>A boardroom for your AI agents.</strong>
    <br />
    Multi-agent orchestration over MCP — deliberation, voting, and human oversight built in.
  </p>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#how-it-works">How It Works</a> &middot;
  <a href="#configuration">Configuration</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="#contributing">Contributing</a>
</p>

---

Council is an orchestrator that lets AI agents debate, propose, refine, and vote on decisions — like a corporate board of directors. Agents connect over [MCP](https://modelcontextprotocol.io/) (Model Context Protocol), communicate through Council's message bus, and follow structured deliberation phases. Humans stay in the loop with a real-time web UI for reviewing and approving decisions.

**Why Council?**

- **Structured multi-agent deliberation** — not just chat, but investigation, proposals, amendments, and formal votes
- **Configurable governance** — quorum rules, veto power, weighted voting, 5 voting schemes, escalation policies
- **Human-in-the-loop by default** — every decision can require human review before execution
- **MCP-native** — agents connect as standard MCP clients, bringing their own tools and capabilities
- **Zero-config agents** — define personas in YAML; Council handles spawning, routing, and state management
- **Persistent agents** — agents can stay connected across sessions, receiving new assignments without re-spawning
- **Dynamic voting weights** — expertise-topic matching automatically adjusts agent influence per session
- **Multi-user auth** — session-based authentication with optional TOTP 2FA and role-based access control
- **MCP for humans too** — a dedicated `/mcp/user` endpoint lets Claude Desktop, Cursor, and VS Code manage sessions, review decisions, and browse resources via API key auth

## How It Works

<p align="center">
  <img src="docs/flow-diagram.svg" alt="Council Deliberation Flow" width="720" />
</p>

1. **Events arrive** — GitHub webhooks, generic webhooks, or manual triggers
2. **Council routes** to the right agents based on event type, labels, and expertise
3. **Agents investigate** autonomously and consult each other through MCP tools
4. **A proposal is made** and debated over multiple deliberation rounds
5. **Amendments are proposed** — agents refine the proposal before it goes to vote
6. **Agents vote** — weighted majority, supermajority, unanimous, consent-based, or advisory
7. **Escalation rules fire** on deadlocks, timeouts, vetoes, or quorum failures
8. **Humans review** the final decision in the web dashboard

All communication flows through Council. Agents never talk directly to each other — Council enforces the communication graph, persists every message, and drives the state machine.

## Quick Start

### Prerequisites

- Node.js 22+
- pnpm

### Install and run

```bash
pnpm install
pnpm dev
```

The server starts on `http://localhost:3000` with the web dashboard and a default development config.

### Run with the example board

```bash
CONFIG_PATH=config/examples/board-of-directors.yaml pnpm dev
```

This spins up a 4-agent board (CTO, CPO, Legal, CFO) with escalation rules, veto power, and weighted voting.

More example configs in [`config/examples/`](config/examples/): `minimal-two-agent`, `code-review-council`, `security-review-board`, `incident-response-team`, `advisory-panel`, `momentumeq-board` (6-agent board with dynamic weights and session topics).

### Run tests

```bash
pnpm test
```

### Docker

Council publishes Docker images to GitHub Container Registry on every push to `main` and on version tags.

**Pull the latest image:**

```bash
docker pull ghcr.io/dadcoachengineer/council:main
```

**Run with a config file:**

```bash
docker run -d \
  --name council \
  -p 3000:3000 \
  -v council-data:/app/data \
  -v $(pwd)/config:/app/config:ro \
  -e CONFIG_PATH=/app/config/examples/board-of-directors.yaml \
  ghcr.io/dadcoachengineer/council:main
```

**Or use Docker Compose:**

```bash
cd docker
docker compose up --build
```

The compose file mounts `config/` read-only and persists the SQLite database in a named volume.

**Available image tags:**

| Tag | Description |
|-----|-------------|
| `main` | Latest build from the main branch |
| `v1.0.0`, `v1.0`, etc. | Semantic version tags (when released) |
| `sha-abc1234` | Pinned to a specific commit |

**Volumes:**

| Path | Purpose |
|------|---------|
| `/app/data` | SQLite database (persist this!) |
| `/app/config` | Council YAML config files (mount read-only) |

The container exposes port `3000` and includes a health check at `/api/health`.

## Configuration

Council is configured entirely via YAML. See [`config/examples/board-of-directors.yaml`](config/examples/board-of-directors.yaml) for a complete working example.

```yaml
council:
  name: "Product Strategy Board"

  agents:
    - id: cto
      role: "Chief Technology Officer"
      expertise: [architecture, security, scalability]
      can_veto: true
      voting_weight: 1.5
      persistent: true          # Stay connected across sessions
      system_prompt: "You are the CTO..."

  rules:
    quorum: 3
    voting_threshold: 0.66
    voting_scheme:
      type: supermajority
      preset: two_thirds
    enable_refinement: true
    dynamic_weights:               # Optional: expertise-topic weight adjustment
      enabled: true
      expertise_match_bonus: 0.5   # Added per matching expertise tag
      max_multiplier: 3.0          # Cap on total effective weight
    escalation:
      - name: "deadlock_retry"
        trigger: { type: deadlock }
        action: { type: restart_discussion }

  event_routing:
    - match: { source: github, type: issues.opened, labels: [bug] }
      assign:
        lead: cto
        consult: [cpo]
        topics: [architecture, security]  # Session expertise tags
```

### Config Sections

| Section | Purpose |
|---------|---------|
| `council.agents` | Agent personas — roles, expertise, voting weights, veto power, system prompts |
| `council.rules` | Governance — quorum, threshold, voting scheme, refinement, max rounds, dynamic weights |
| `council.rules.escalation` | Auto-escalation on deadlock, timeout, veto, quorum failure, or max rounds |
| `council.rules.dynamic_weights` | Optional expertise-topic weight adjustment at vote tally time |
| `council.event_routing` | Route events to lead/consult agents by source, type, labels, and topics |
| `council.communication_graph` | Control which agents can message each other |
| `council.spawner` | Agent launch mode: `log` (dev), `webhook`, or `sdk` (production) |

### Agent `persistent` Flag

Agents with `persistent: true` stay connected across multiple sessions:
- They receive a stable authentication token stored in the database
- When a new session is created, the orchestrator notifies them via MCP instead of re-spawning
- They can poll for assignments using the `council_get_assignments` tool
- SDK-spawned persistent agents run in a loop, processing sessions from an internal queue

### Manual Agent Example

The [`examples/manual-agent.ts`](examples/manual-agent.ts) script demonstrates how to connect an external MCP client to Council as a standalone agent. Run it with:

```bash
npx tsx examples/manual-agent.ts
```

### Voting Schemes

| Scheme | How It Works |
|--------|-------------|
| `weighted_majority` | Weighted votes, passes at threshold (default) |
| `supermajority` | Requires 2/3 or 3/4 majority, or custom threshold |
| `unanimous` | Every non-abstaining voter must approve |
| `consent_based` | Passes unless someone formally objects |
| `advisory` | Non-binding — always passes, results are informational |

### Escalation Rules

Escalation rules fire automatically during deliberation when things go sideways.

| Trigger | Fires When |
|---------|-----------|
| `deadlock` | Votes are split with no clear winner |
| `quorum_not_met` | Not enough agents voted |
| `veto_exercised` | An agent with veto power blocked the proposal |
| `timeout` | A phase exceeded its time limit |
| `max_rounds_exceeded` | Too many deliberation rounds |

| Action | What It Does |
|--------|-------------|
| `escalate_to_human` | Flags the session for human review |
| `restart_discussion` | Resets deliberation for another round |
| `add_agent` | Brings in an additional agent |
| `auto_decide` | Forces a decision (approve/reject/escalated) |
| `notify_external` | Sends a webhook to an external service |

Rules support `priority` ordering, `stop_after` to halt after the first match, and `max_fires_per_session`.

## Authentication

Council uses multi-user session-based authentication with optional TOTP two-factor authentication.

- **First-run setup**: `POST /auth/setup` creates the initial admin user
- **Login**: `POST /auth/login` returns a session cookie; supports optional TOTP verification via `POST /auth/2fa/verify`
- **User management**: Admins can create and manage users at `/api/admin/users`
- **MCP endpoint (agents)**: `/mcp` is exempt from auth — agents authenticate with their own `x-agent-token` header
- **MCP endpoint (users)**: `/mcp/user` authenticates via `Authorization: Bearer <api-key>` — for human MCP clients
- **API key management**: Admins create/list/revoke API keys at `/api/admin/api-keys`

## Architecture

```
src/
  engine/    Pure logic — orchestrator, voting, escalation, spawner, message bus
  server/    HTTP layer — Express 5 routes, MCP server, WebSocket, auth, DB
  web/       Frontend — Preact + Vite dashboard
  shared/    Types, Zod schemas, event definitions (imported by all layers)
```

### REST API

| Endpoint | Purpose |
|----------|---------|
| `POST /webhooks/github` | GitHub webhook receiver (HMAC verified) |
| `POST /webhooks/ingest` | Generic webhook receiver |
| `GET /api/sessions` | List deliberation sessions |
| `GET /api/sessions/:id` | Session details with messages, votes, decision |
| `POST /api/sessions` | Create a manual session |
| `POST /api/sessions/:id/review` | Submit human review |
| `GET /api/events` | List incoming events |
| `GET /api/agents` | List agent connection statuses |
| `GET /api/decisions` | List pending decisions |
| `POST /auth/setup` | First-run admin user creation |
| `POST /auth/login` | Login (returns session cookie) |
| `GET /api/admin/users` | List users (admin only) |
| `POST /api/admin/api-keys` | Create API key for a user (admin only) |
| `GET /api/admin/api-keys` | List API keys for a user (admin only) |
| `DELETE /api/admin/api-keys/:id` | Revoke an API key (admin only) |
| `GET /api/admin/agent-tokens` | List persistent agent tokens (admin only) |
| `POST /api/admin/agent-tokens/:agentId` | Provision a persistent token (admin only) |
| `DELETE /api/admin/agent-tokens/:agentId` | Revoke a persistent token (admin only) |
| `ws://host/ws` | WebSocket for real-time UI updates |

### MCP Tools (Agent-Facing)

Agents connect to `/mcp` via Streamable HTTP and use these tools:

| Tool | Description |
|------|-------------|
| `council_get_context` | Get pending tasks, messages, and session state |
| `council_get_session` | Full session details including votes and phase |
| `council_send_message` | Message an agent or broadcast (graph-enforced) |
| `council_consult_agent` | Request input from another board member |
| `council_create_proposal` | Create a formal proposal for deliberation |
| `council_submit_findings` | Submit investigation results |
| `council_cast_vote` | Vote with reasoning (values depend on voting scheme) |
| `council_propose_amendment` | Propose a change to the active proposal |
| `council_resolve_amendment` | Accept or reject an amendment (lead agent) |
| `council_get_voting_info` | Get the voting scheme and valid vote values |
| `council_list_sessions` | List sessions with optional filters |
| `council_list_councils` | List available councils |
| `council_get_assignments` | Get current session assignments (persistent agents) |

### MCP Tools (User-Facing)

Human MCP clients (Claude Desktop, Cursor, VS Code) connect to `/mcp/user` with an API key and get access to:

| Tool | Description |
|------|-------------|
| `council_user_list_sessions` | List sessions with optional phase filter |
| `council_user_get_session` | Full session details with messages, votes, decision |
| `council_user_create_session` | Create a new deliberation session |
| `council_user_submit_review` | Approve, reject, or send back a decision |
| `council_user_list_pending_decisions` | List decisions awaiting human review |
| `council_user_get_agents` | Get agent connection statuses |
| `council_user_transition_phase` | Manually advance a session's phase |
| `council_user_ingest_event` | Ingest an event to trigger routing |

**Resources** (`council://` URI scheme): `config`, `agents`, `decisions/pending`, `sessions`, `sessions/{sessionId}`

**Prompts**: `start-deliberation`, `review-decisions`, `check-agents`

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Server host |
| `DB_PATH` | `./data/council.db` | SQLite database path |
| `CONFIG_PATH` | — | Path to council YAML config |
| `MCP_BASE_URL` | `http://localhost:3000/mcp` | URL agents use to connect back |
| `GITHUB_WEBHOOK_SECRET` | — | GitHub webhook HMAC secret |

## Tech Stack

| | |
|---|---|
| **Runtime** | Node.js 22+, TypeScript 5.7+ |
| **Server** | Express 5 |
| **Frontend** | Preact + Vite |
| **Database** | SQLite (better-sqlite3 + Drizzle ORM) |
| **Agent Protocol** | MCP (Model Context Protocol) via @modelcontextprotocol/sdk |
| **Agent Spawning** | Claude Agent SDK or webhook-based |
| **Testing** | Vitest — 265 tests |

## Contributing

Contributions are welcome! Council is early-stage and there's a lot of surface area to improve.

**Good first areas:**

- **New voting schemes** — implement the `VotingScheme` interface in `src/engine/voting-schemes/`
- **New escalation actions** — add handlers in `src/engine/escalation-engine.ts`
- **Web UI improvements** — the Preact dashboard in `src/web/` could use polish
- **New spawner backends** — add alternatives to Claude SDK in `src/engine/spawner.ts`
- **Documentation** — examples, tutorials, and guides

### Development workflow

```bash
pnpm install          # Install dependencies
pnpm dev              # Start dev server with hot reload
pnpm test             # Run test suite
npx tsc --noEmit      # Type check
```

### Submitting changes

1. Fork the repo and create a feature branch
2. Make your changes with tests
3. Run `pnpm test` and `npx tsc --noEmit`
4. Open a PR with a summary and test plan

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
