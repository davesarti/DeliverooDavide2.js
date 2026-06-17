# Deliveroo.js Agent

An autonomous agent for the [Deliveroo.js](https://github.com/unitn-ASA/Deliveroo.js)
multi-agent game (UniTN *Autonomous Software Agents* course). The agent picks up
parcels, delivers them to delivery tiles for points, and competes/cooperates with
other agents on the map.

## Scope

The project combines two complementary deciders that can run alone or as a
cross-linked pair:

- **BDI agent** — a classic Belief–Desire–Intention loop. It senses the world,
  generates options (pick up, deliver, explore, camp a spawn pocket), scores them
  against a decaying-reward model, and commits to the best intention with
  hysteresis. Pathfinding is A\* (with BFS available) and there is an optional
  PDDL planner for crate-pushing / tile-reaching subgoals.
- **LLM agent** — a mission executor driven by a language model through native
  function calling. It receives missions, reasons one tool-call at a time over the
  live game state, and can install *durable rules* (value bands, preferred /
  penalised delivery tiles, stack-size preferences) that bias the BDI scorer.

In `MULTI` mode a BDI agent and an LLM agent are launched as **partners**: the LLM
sends directives/signals over the SDK `say` channel and the BDI executes them,
reporting status back. Durable rules set by the LLM are serialized and synced to a
BDI-only partner so both agents share the same strategy.

## Directory structure

```
DeliverooDavide2.js/
├── index.js                  # Entry point: validates config, wires beliefs/actions/sockets, launches instances
├── config.js                 # Resolves LLM provider, Deliveroo host, agent mode/count and tokens from env + CLI
├── socket.js                 # Thin wrapper creating the Deliveroo SDK connection
├── test-runner.js            # End-to-end mission test driver: sends a battery of missions to a running LLM agent and logs replies
├── package.json              # Dependencies and npm scripts (start / local / remote)
├── .env.example              # Template for the required environment variables
│
├── beliefs/                  # The agent's model of the world (sensing)
│   ├── beliefState.js        # Factory for the initial belief-state object (me, parcels, agents, map, rules…)
│   ├── updateBeliefs.js      # Binds socket events (onConfig/onYou/onMap/onParcels/onAgents) to belief updates
│   └── mapState.js           # Builds the grid + per-cell distance maps to delivery and spawn tiles
│
├── bdi/                      # The BDI reasoning loop (deciding)
│   ├── bdiAgent.js           # Main BDI control loop: sense → generate options → score → commit intention
│   ├── options.js            # Option generation and the scoring factors (distance, decay, camping, race-win prob.)
│   ├── ruleScoring.js        # Applies durable rules (value bands, stack/tile preferences) to option scores
│   ├── intention.js          # Intention/plan abstraction with stop & preemption error handling
│   └── coordination.js       # BDI-side coordination: receives partner directives, replies with status
│
├── actions/
│   └── actions.js            # Executable primitives (move, pickup, putdown, goTo, explore, camp) on the live game
│
├── pathfinding/              # Route planning on the grid
│   ├── pathfinding.js        # Dispatcher selecting the algorithm
│   ├── bfs.js                # Breadth-first shortest path over the state
│   └── astar.js              # A\* with soft obstacles (nearby agents block, far agents add a penalty)
│
├── pddl/                     # Optional symbolic planner for subgoals
│   ├── domain.pddl           # Static PDDL domain (tiles, moves, pickup/putdown, crate pushing)
│   ├── problemBuilder.js     # Translates belief state + goal descriptor into a PDDL problem string
│   ├── pddlPlanner.js        # Calls the online solver and returns the plan steps
│   └── planExecutor.js       # Maps each PDDL step back onto an actions.* call against the real game
│
├── llm/                      # The LLM mission executor (deciding)
│   ├── agent.js              # LLM agent loop: builds the mission prompt, runs the tool-calling turn, validates
│   ├── client.js             # OpenAI-compatible client wrapper (native function calling, one retry)
│   ├── tools.js              # Implementations of the executor tools (calculate, environment queries, rule stores…)
│   ├── coordinator.js        # LLM-side coordination: sends directives/signals, awaits partner status by cid
│   ├── llmState.js           # Minimal cross-turn state (coordination context that must survive between turns)
│   ├── rulesValidator.js     # Rejects actions that violate the installed persistent rules
│   ├── historyLogger.js      # Per-session JSONL/JSON logs of decisions, events, missions and rule timeline
│   ├── history/              # Timestamped run logs written by historyLogger (gitignored output)
│   └── prompts/
│       ├── index.js          # Re-exports the executor prompt, tool defs, prompt builder and action mapper
│       └── Executor/
│           ├── ExecutorPrompt.js       # System prompt describing the executor role and output contract
│           ├── executorExamples.js     # Few-shot mission → tool-sequence examples
│           ├── toolExecutorDefs.js     # Tool/function schemas exposed to the model
│           ├── formatExecutorPrompt.js # Builds the per-mission user prompt (mission + rules + state snapshot)
│           └── actionMapper.js         # Maps model-facing tool names onto internal action names
│
└── utils/                    # Shared helpers
    ├── constants.js          # Tunable constants (A\* costs, TTLs, camp patience, decay defaults…)
    ├── asyncUtils.js         # wait / yieldControl / waitUntil promise helpers
    ├── mapUtils.js           # Grid/movement helpers (directions, reachability, distance, observable tiles)
    ├── stateUtils.js         # Nearest delivery/spawn-tile lookups and duration parsing
    ├── decayModel.js         # Event-based parcel-decay-per-step estimator (no wall clock in scoring)
    ├── coordProtocol.js      # Wire protocol for BDI↔LLM messages (directive / signal / status / rules-update)
    ├── rulesSync.js          # Serialize/deserialize the ruleset so it can travel to a BDI-only partner
    └── rulesLogger.js        # Periodic read-only logger that prints each agent's current ruleset
```

## Setup

Install dependencies:

```bash
npm install
```

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

### Configuration reference

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `HOST` | yes | — | Deliveroo server URL (`http://localhost:8080` local, or the remote server). |
| `AGENT_MODE` | no | `MULTI` | `BDI`, `LLM`, or `MULTI` (BDI + LLM paired). |
| `AGENT_COUNT` | no | all token pairs | Caps the number of instances launched. |
| `TOKEN_BDI_1`, `TOKEN_LLM_1`, … | depends on mode | — | Per-instance agent tokens (numbered pairs). |
| `LLM_PROVIDER` | LLM/MULTI only | `openrouter` | Active LLM endpoint: `openrouter` or `litellm`. |
| `OPENROUTER_API_KEY` | if provider=openrouter | — | OpenRouter API key. |
| `OPENROUTER_MODEL` | no | `meta-llama/llama-3.3-70b-instruct` | Model id on OpenRouter. |
| `OPENROUTER_BASE_URL` | no | `https://openrouter.ai/api/v1` | Override the OpenRouter endpoint. |
| `OPENROUTER_SITE_URL`, `OPENROUTER_APP_NAME` | no | — | Optional OpenRouter ranking headers (sent only if set). |
| `LITELLM_API_KEY` | if provider=litellm | — | API key for the self-hosted LiteLLM gateway. |
| `LITELLM_BASE_URL` | no | `https://llm.bears.disi.unitn.it/v1` | LiteLLM gateway URL. |
| `LOCAL_MODEL` | no | `llama-3.3-70b-lmstudio` | Model id served by the LiteLLM gateway. |
| `CAMP` | no | `true` | Set to `false`/`0`/`no`/`off` to disable carry-camping spawn pockets. |
| `LLM_TARGET_NAME` | test runner only | `LLM` | Name of the LLM agent the test runner targets. |

**Tokens.** Each instance needs the token(s) its mode requires (see the table
below). Use numbered pairs for multiple instances (`TOKEN_BDI_1`/`TOKEN_LLM_1`,
`TOKEN_BDI_2`/`TOKEN_LLM_2`, …); a single unnumbered `TOKEN_BDI` / `TOKEN_LLM`
also works as a fallback. In `MULTI` mode the number of instances is the number
of *complete* BDI+LLM pairs; `AGENT_COUNT` can only cap (never exceed) the
available sets.

**LLM provider.** `LLM_PROVIDER` selects which credentials are read. The client
sees a stable `{ baseURL, apiKey, model }` shape either way, so switching
providers is just a matter of changing this one variable and supplying the
matching key. The LLM key is only required when the mode actually uses the LLM
(`LLM` or `MULTI`).

A minimal local `MULTI` setup (OpenRouter) looks like:

```env
HOST=http://localhost:8080
AGENT_MODE=MULTI
AGENT_COUNT=1

LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=meta-llama/llama-3.3-70b-instruct

TOKEN_BDI_1=your_bdi_token_here
TOKEN_LLM_1=your_llm_token_here
```

## Running

```bash
npm start              # uses HOST from .env
npm run local          # forces HOST=http://localhost:8080
npm run remote         # forces HOST=https://deliveroojs.bears.disi.unitn.it/
```

`--mode` and `--count` can be passed at launch and take precedence over env vars:

```bash
node index.js --mode MULTI --count 2   # two BDI+LLM pairs
node index.js --mode BDI   --count 1   # one BDI-only agent
```

## Testing

`test-runner.js` is an end-to-end experiment driver for the LLM agent — not a unit
test suite. It connects to the **already-running** Deliveroo.js server as a
separate `TestRunner` client, discovers the LLM agent by name (`LLM_TARGET_NAME`,
default `LLM`), and sends a graded battery of ~80 missions one at a time over the
chat (`say`) channel, recording each reply.

The missions are organised in three levels: **L1 atomic** (single moves/drops,
factual and arithmetic queries, plus negative-reward / placeholder cases the agent
should reject), **L2 persistent rules** (stack-size, delivery-tile multipliers /
bonuses, navigation blocks, parcel-value bands, collect-and-deliver tasks), and
**L3 coordination** (rendezvous, parcel handoff, red-light/green-light signalling).
Each mission carries an `expected` outcome (`accepted` / `rejected`) for grading.

Start the server and at least one agent first (`AGENT_MODE=LLM` or `MULTI`), then:

```bash
node test-runner.js                 # run the full battery
node test-runner.js --dry-run       # print the mission list and exit (no server needed)
node test-runner.js --from 5        # start from mission #5 (1-based)
node test-runner.js --only 3,7,12   # run only these mission indices
```

Results are written incrementally (after every reply, so a crash never loses
progress) to `test-results-<timestamp>.json`, including each mission's status
(`replied` / `timeout`), the reply text, timings, and a run summary. Each mission
has a 90s reply timeout with a 2s pause between missions.

## Modes

| Mode | Tokens needed | Description |
|------|--------------|-------------|
| `MULTI` (default) | `TOKEN_BDI_1` + `TOKEN_LLM_1` | Launches a BDI agent and an LLM agent, cross-linked as partners |
| `LLM` | `TOKEN_LLM_1` | Launches only the LLM agent |
| `BDI` | `TOKEN_BDI_1` | Launches a BDI-only agent, no LLM required |
