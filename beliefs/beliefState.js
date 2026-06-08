export const beliefState = {
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

  onUpdate: null,
};