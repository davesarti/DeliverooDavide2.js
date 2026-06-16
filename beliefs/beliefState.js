/*
 * Creates the initial belief state of the agent.
 */
export function createBeliefState() {
  return {
    me: {
      id: null,
      name: null,
      x: null,
      y: null,
      score: 0,
    },

    parcels: new Map(),
    crates: new Map(),
    agents: new Map(),

    map: {
      width: null,
      height: null,
      tiles: [],
      deliveryTiles: [],
      spawnTiles: [],
      // Tiles a crate can be pushed onto: server tile types "5" (sliding tile)
      // and "5!" (crate spawner). Populated in updateBeliefs from onMap and
      // consumed by the PDDL problem builder to emit (pushable ?t) facts.
      pushableTiles: [],
      deliveryDistanceMap: [],
      spawnDistanceMap: [],
      grid: [],
    },

    config: {
      observationDistance: null,
      movementDuration: null,
      playerCapacity: null,
      parcelDecayingEvent: null,
      parcelGenerationEvent: null,
      maxParcels: null,
    },

    // Event-based decay model state.
    // decayTicks: global counter of observed server decay events (each -1 on
    // a sensed parcel's reward is one tick — the parcels' rewards ARE the
    // clock; no wall time involved).
    // decayPerStep: EMA of "ticks per completed move", i.e. the reward each
    // carried parcel loses per tile of travel; null until the first sample
    // (the config-derived prior is used meanwhile).
    timing: {
      decayTicks: 0,
      decayPerStep: null,
    },

    partner: null,

    // BDI <-> LLM coordination (directive mode). When `active`, normal option
    // generation and opportunistic actions are suspended and the agent executes
    // queued directives one at a time. `waiting` is a single bool because only
    // one `wait` is ever parked at a time (directives run sequentially); any
    // incoming signal flips it false. `sendStatus` and `lastActivityMs` are
    // attached at runtime by setupBdiCoordination.
    coordination: {
      active: false,
      queue: [],
      current: null,
      waiting: false,
      sendStatus: null,
      lastActivityMs: 0,
    },

    // Durable strategy rules, set by the LLM as it interprets missions and
    // persisting across them (single source of truth — previously held on the
    // separate llmState). The BDI agent carries this section too, but only the
    // LLM agent's tools mutate it. `rendered` is the human/LLM-readable text
    // derived from the structured fields; keep it in sync via the rule tools.
    // The tile collections are Maps keyed by "x,y"; each value carries a
    // magnitude (penalty/reward) supplied by the LLM, defaulted when omitted.
    // These are soft preferences, NOT hard constraints: penaltyTiles add cost
    // in A* (they never make a tile impassable), so a rule can never strand
    // the agent.
    rules: {
      // Array of stack-size rules { mode, count, met, unmet }. Several
      // compatible constraints can be active at once (e.g. at_least 2 +
      // at_most 5); conflicting ones are resolved when set (see setStackSize).
      stackSize: [],

      parcelFilters: {
        minReward: null,
        maxReward: null,
      },

      penaltyDeliveries: new Map(),   // "x,y" -> { x, y, penalty }
      preferredDeliveries: new Map(), // "x,y" -> { x, y, reward }

      deliveryMultipliers: new Map(), // "x,y" -> multiplier

      penaltyTiles: new Map(),        // "x,y" -> { x, y, penalty }  (navigation)

      rendered: "None.",

      // Optional hook fired after any rule add/drop (set at runtime by the LLM
      // agent to push the updated ruleset to its BDI-only partner). Null = no
      // listener, e.g. on the BDI agent's own belief state.
      onChange: null,
    },

    // Last place a free parcel was actually seen ({ x, y, ts }). Camp uses it
    // as the anchor to loiter near — i.e. "wait where parcels appear". Null
    // until the first free parcel is observed.
    lastParcelHint: null,

    // Carry state, refreshed once per sensing in updateBeliefs.
    // count: parcels currently carried (single source of truth — every other
    //   module reads this instead of re-scanning bs.parcels).
    // campSteps: tiles patrolled while holding parcels in the current carry
    //   episode; bounds how much reward the agent may bleed to decay before it
    //   must deliver. Reset to 0 whenever the agent is no longer carrying.
    carry: { count: 0, campSteps: 0 },

    onUpdate: null,
  };
}