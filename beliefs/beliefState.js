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

    // Last place a free parcel was actually seen ({ x, y, ts }). Camp uses it
    // as the anchor to loiter near — i.e. "wait where parcels appear". Null
    // until the first free parcel is observed.
    lastParcelHint: null,

    // Camp-while-carrying loss budget. campSteps counts tiles patrolled while
    // holding parcels in the current carry episode; it bounds how much reward
    // the agent may bleed to decay before it must deliver. Reset to 0 whenever
    // the agent is no longer carrying anything.
    carry: { campSteps: 0 },

    onUpdate: null,
  };
}