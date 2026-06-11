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

    partner: null,

    onUpdate: null,
  };
}