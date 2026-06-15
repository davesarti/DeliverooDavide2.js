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