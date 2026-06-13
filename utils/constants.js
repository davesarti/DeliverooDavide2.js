// Constants used in A*
export const BASE_STEP_COST = 1;
export const MIN_EDGE_COST = 0.1;
export const PARCEL_REWARD_DISCOUNT = 0.2;

// Soft obstacles in A*: agents within this Manhattan radius of the path
// start are hard obstacles (they are actually in the way now); farther
// agents only add a step penalty (they will likely have moved by the time
// we arrive).
export const SOFT_OBSTACLE_HARD_RADIUS = 2;
export const AGENT_SOFT_PENALTY = 5;

// Constants used in mapUtils
export const PARCEL_DECAY = 1; // used only as fallback if the server does not provide parcels.decaying_event

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
// Out-of-view parcels are evicted after ~2x the time needed to cross the
// map (computed from config); this is the fallback when config is missing.
export const PARCEL_MEMORY_TTL_FALLBACK_MS = 30000;

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

// Adaptive camp patience — "is this pocket worth waiting at, and for how long".
// Driven purely by SPATIAL spawn-cluster density: the number of spawn
// ("green") tiles within CAMP_ADJACENCY_RADIUS of the pocket, which is what
// actually signals "worth camping". A fixed base unit is scaled UP
// exponentially per extra green tile, so an isolated tile barely camps and a
// dense cluster earns a long (capped) wait. The curve starts at 0 — a lone
// green tile is not worth camping — and climbs exponentially per extra tile to
// the MAX cap. The spawn *rate* is deliberately NOT used as the base — tying
// patience to it is backwards, since a sporadic (slow) map would then camp
// longest. Generation 'infinite' (no respawns) is still honoured as a yes/no
// gate (camping disabled).
//   patience = clamp(BASE_MS × (GROWTH^(adjacentSpawnTiles − 1) − 1), MIN, MAX)
export const CAMP_PATIENCE_BASE_MS = 1000;
export const CAMP_PATIENCE_GROWTH = 1.6;
export const CAMP_ADJACENCY_RADIUS = 3;
export const CAMP_PATIENCE_MIN_MS = 0;
export const CAMP_PATIENCE_MAX_MS = 8000;

// Constants used in stateUtils
export const MOVING_WINDOW_MS = 10000;
export const STALENESS_WEIGHT = 0.7;

export const RUNTIME = {
  READINESS_CHECK_DELAY_MS: 100,

  // Path-proportional timeout: path.length x movementDuration x safety
  // factor, never below GO_TO_TIMEOUT_MS (kept as the floor and as the
  // default for external callers that don't pass a path).
  GO_TO_TIMEOUT_MS: 5000,
  GO_TO_TIMEOUT_SAFETY_FACTOR: 3,

  // Retry-then-replan on blocked steps: retry the same step a few times
  // (transient crossing agent), then recompute the path from the current
  // position, and only fail after several replans.
  MOVEMENT_RETRY_DELAY_MS: 150,
  MOVE_RETRY_LIMIT: 3,
  // Each replan now hard-avoids the tiles that just refused us, so replans
  // converge (every one rules out a blocked corridor) instead of thrashing
  // between two — the budget can be generous without spinning.
  MAX_REPLANS: 6,

  // Yield-in-place backoff. When a move is refused by a *moving* agent (not
  // a wall/crate), wait a randomized interval and retry the same step a few
  // times before rerouting. The randomness desynchronizes two agents caught
  // mirroring each other, so one slips through while the other holds still.
  YIELD_RETRY_LIMIT: 4,
  YIELD_BACKOFF_MIN_MS: 100,
  YIELD_BACKOFF_MAX_MS: 500,

  MAX_CONSECUTIVE_WAITS: 50,

  // Failure pool: exponential backoff per predicate key
  // (3s -> 6s -> 12s -> ... capped), failure counter reset after a quiet
  // period or on success.
  FAILED_INTENTION_RETRY_MS: 3000,
  FAILED_INTENTION_RETRY_MAX_MS: 30000,
  FAILURE_STATS_RESET_MS: 60000,

  // Rate-limited reconsideration: full options regeneration runs on
  // significant belief changes, or at most this often.
  RECONSIDERATION_MIN_INTERVAL_MS: 250,
};

// Constants used in LLM agent
export const MAX_ITERATIONS = 75;
export const MAX_MISSION_HISTORY = 0;
