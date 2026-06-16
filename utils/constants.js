// Constants used in A*
export const BASE_STEP_COST = 1;
export const MIN_EDGE_COST = 0.1;

// Soft obstacles in A*: agents within this Manhattan radius of the path
// start are hard obstacles (they are actually in the way now); farther
// agents only add a step penalty (they will likely have moved by the time
// we arrive).
export const SOFT_OBSTACLE_HARD_RADIUS = 2;
export const AGENT_SOFT_PENALTY = 7.5;

// Event-based decay model defaults (used only when the server config is
// missing; both processes are normally read from bs.config).
export const DEFAULT_MOVEMENT_DURATION_MS = 500;
export const DEFAULT_DECAY_INTERVAL_MS = 1000;
// Smoothing for the measured decay-per-step samples (rewards are integers,
// so single samples read 0 or 1 — the EMA firms up over ~10-20 steps).
export const DECAY_EMA_ALPHA = 0.15;

// Belief persistence TTLs.
// Agents move fast: remember a last-seen position only briefly (it feeds
// the soft obstacles and the congestion estimates, both short-horizon).
export const AGENT_MEMORY_TTL_MS = 3000;

// Commitment with hysteresis: a challenger must beat the running
// intention's score by this relative margin to preempt it.
export const PREEMPTION_HYSTERESIS = 0.25;
export const PREEMPTION_EPSILON = 0.001;

// Congestion-aware pickup scoring: temperature (in tiles) of the race
// win-probability sigmoid.
export const RACE_DISCOUNT_TAU = 2;

// Anti-hoarding guard: never accumulate more than this many parcels
// (effective cap is min(HOARD_CAP, server-declared capacity)). Deliberately
// generous so that camping a far spawn cluster stays viable.
export const HOARD_CAP = 10;

// Camp patrol: spawn tiles within this Manhattan radius of the anchor form
// the pocket the agent loops over while camping.
export const CAMP_PATROL_RADIUS = 5;

// Camp-while-carrying loss budget: the agent may keep camping for more parcels
// only while the reward it has bled to decay this carry episode stays under
// this fraction of its carried value. 0 decay ⇒ unbounded (free to fill up);
// fast decay ⇒ ~0 steps ⇒ it delivers right away.
export const CAMP_LOSS_BUDGET_FRACTION = 0.05;

// Camp-while-carrying delivery proximity guard: camping to GATHER MORE only pays
// off when delivery is far enough that amortizing the trip beats quick
// pickup→deliver cycles. When a delivery tile is within this many tiles, a
// carrying agent delivers instead of loitering for a fuller load. Only gates the
// carrying camp; idle camping (empty-handed pickup loitering) is unaffected.
export const CAMP_NEAR_DELIVERY_TILES = 8;

// Adaptive camp patience — "is this pocket worth waiting at, and for how long".
// Driven purely by SPATIAL spawn-cluster density: the number of spawn
// ("green") tiles within CAMP_ADJACENCY_RADIUS of the pocket, which is what
// actually signals "worth camping". A fixed base unit is scaled UP
// exponentially per extra green tile, so a thin cluster barely camps and a
// dense one earns a long (capped) wait. Below CAMP_PATIENCE_MIN_TILES the
// pocket is too sparse to camp at all (patience 0); from there the curve
// climbs exponentially and SATURATES at CAMP_PATIENCE_SATURATION_TILES, where
// it reaches the MAX cap (counts above that add nothing). The spawn *rate* is
// deliberately NOT used as the base — tying patience to it is backwards, since
// a sporadic (slow) map would then camp longest. Generation 'infinite' (no
// respawns) is still honoured as a yes/no gate (camping disabled).
//   n = clamp(adjacentSpawnTiles, MIN_TILES, SATURATION_TILES)
//   patience = clamp(BASE_MS × (GROWTH^(n − (MIN_TILES − 1)) − 1), MIN, MAX)
//             (and 0 when adjacentSpawnTiles < MIN_TILES)
export const CAMP_PATIENCE_BASE_MS = 1000;
// Below this many adjacent spawn tiles the pocket is not worth camping.
export const CAMP_PATIENCE_MIN_TILES = 4;
// At/above this many the curve saturates (hits MAX); extra tiles add nothing.
export const CAMP_PATIENCE_SATURATION_TILES = 10;
// Tuned so patience reaches CAMP_PATIENCE_MAX_MS exactly at the saturation
// count: 1000 × (GROWTH^(10 − 3) − 1) ≈ 8000  ⇒  GROWTH ≈ 9^(1/7).
export const CAMP_PATIENCE_GROWTH = 1.37;
export const CAMP_ADJACENCY_RADIUS = 3;
export const CAMP_PATIENCE_MIN_MS = 0;
export const CAMP_PATIENCE_MAX_MS = 8000;

// Spawn-tile exploration: weight of staleness vs distance in findCellsToExplore.
export const STALENESS_WEIGHT = 0.7;

export const RUNTIME = {
  READINESS_CHECK_DELAY_MS: 100,

  // Path-proportional timeout: path.length x movementDuration x safety
  // factor, never below GO_TO_TIMEOUT_MS (kept as the floor and as the
  // default for external callers that don't pass a path).
  GO_TO_TIMEOUT_MS: 5000,
  GO_TO_TIMEOUT_SAFETY_FACTOR: 3,

  // A blocked step reroutes immediately (goTo replans around the proven
  // blocked tile), so there is no per-step retry for static blocks — only the
  // moving-agent yield below waits in place. MOVEMENT_RETRY_DELAY_MS is the
  // short pause the idle camp patrol waits between loops.
  MOVEMENT_RETRY_DELAY_MS: 150,
  // Replans hard-avoid the tiles that just refused us, so each one rules out a
  // blocked corridor and they converge fast. A small budget is enough: after
  // this many the target hands off to the failed pool (exponential backoff),
  // instead of the agent persisting on a blocked path for several seconds.
  MAX_REPLANS: 3,

  // Avoid-tile tenure. A tile that just physically refused us is hard-avoided
  // for only a short, movement-scaled window (this many move-durations), then
  // becomes eligible again. Kept short on purpose: a blocking agent clears a
  // tile in a move or two and is still in sensing then, so the route is
  // reconsidered while we can still see whether the choke really opened —
  // a long tenure would only "retry" the route after the agent left sensing.
  AVOID_TENURE_MOVE_FACTOR: 3,

  // Yield-in-place backoff. When a move is refused by a *moving* agent (not
  // a wall/crate), wait a random interval in [0, this many server
  // move-durations] and retry the same step once before rerouting. The upper
  // bound scales to the server's movement duration so the wait can cover a
  // full step of the blocking agent; the randomness desynchronizes two agents
  // caught mirroring each other, so one slips through while the other holds.
  // If the single wait doesn't clear it, rerouting recovers faster.
  YIELD_RETRY_LIMIT: 1,
  YIELD_BACKOFF_MOVE_FACTOR: 3,

  // Failure pool: a single flat cooldown before a failed predicate is retried.
  // No exponential backoff — a failure is almost always transient congestion
  // (a crossing agent at a choke) that clears within a moment, not a genuinely
  // unreachable target: an unreachable free parcel is quickly taken by a closer
  // agent and vanishes from beliefs (its id-keyed option never regenerates), so
  // there is nothing to "back off" from. The loop's validity checks already
  // drop taken/undeliverable intentions before they reach the pool. So just
  // re-probe at a steady short interval.
  FAILED_INTENTION_RETRY_MS: 1000,

  // Rate-limited reconsideration: full options regeneration runs on
  // significant belief changes, or at most this often.
  RECONSIDERATION_MIN_INTERVAL_MS: 250,
};

// Constants used in LLM agent
export const MAX_ITERATIONS = 100;

// Default magnitudes for LLM tile rules, used when the executor does not
// supply an explicit penalty/reward. Arbitrary for now — rule consumption
// (pathfinding/scoring) is not yet wired, so these are just seed values.
export const DEFAULT_FORBID_PENALTY = 10;
export const DEFAULT_PREFER_REWARD = 10;
export const DEFAULT_BLOCK_PENALTY = 10;

// Constants used for BDI <-> LLM coordination
// BDI `wait` primitive self-releases after this if no signal arrives (never
// frozen forever). Kept short so an accidental `wait` directive (e.g. the LLM
// mistakenly parking the partner instead of using wait_for_partner) recovers
// quickly rather than blocking for a full minute.
export const COORD_WAIT_DEFAULT_TIMEOUT_MS = 12000;
// LLM `wait_for_partner` gives up after this so the executor loop never hangs.
export const COORD_LLM_WAIT_TIMEOUT_MS = 60000;
// BDI auto-resumes (exits directive mode) if it sits active with an empty queue
// and no coordination traffic this long — defends against an LLM that crashed
// mid-mission without sending `resume`.
export const COORD_RESUME_IDLE_TTL_MS = 15000;
