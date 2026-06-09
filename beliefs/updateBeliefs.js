import { socket } from "../socket.js";
import { beliefState } from "./beliefState.js";
import { updateSpawnStaleness, updateTilesPerSecond } from "../utils/mapUtils.js";
import { buildGrid, buildDeliveryDistanceMap, buildSpawnDistanceMap,} from "./mapState.js";

// ==========================================
// Constants
// ==========================================
let observationDistance;

socket.onConfig((config) => {
  observationDistance = config.GAME.player.observation_distance;
});

// ==========================================
// Agent State
// ==========================================

let lastYou = null;

socket.onYou(({ id, name, x, y, score }) => {
  const current = `${id}|${x}|${y}|${score}`;

  if (current === lastYou) return;
  lastYou = current;

  beliefState.me.id = id;
  beliefState.me.name = name;
  beliefState.me.x = x;
  beliefState.me.y = y;
  beliefState.me.score = score;

  updateSpawnStaleness(
    beliefState.me,
    beliefState.map.spawnTiles,
    observationDistance
  );

  updateTilesPerSecond(x, y);

  //console.log("[YOU]", { id, name, x, y, score });
});

// ==========================================
// Map State
// ==========================================

socket.onMap((width, height, tiles) => {
  beliefState.map.width = width;
  beliefState.map.height = height;
  beliefState.map.tiles = tiles;
  beliefState.map.grid = buildGrid(width, height, tiles);

  beliefState.map.deliveryTiles = tiles.filter((tile) => tile.type == 2);
  
  beliefState.map.spawnTiles = tiles
    .filter((tile) => tile.type == 1)
    .map((tile) => ({ ...tile, staleness: 0 }));

  beliefState.map.deliveryDistanceMap = buildDeliveryDistanceMap(
    width,
    height,
    tiles,
    beliefState.map.deliveryTiles
  );

  beliefState.map.spawnDistanceMap = buildSpawnDistanceMap(
    width,
    height,
    tiles,
    beliefState.map.spawnTiles
  );

  console.log(
    `Map received: ${beliefState.map.spawnTiles.length} spawn tiles, ${beliefState.map.deliveryTiles.length} delivery tiles`
  );
});

// ==========================================
// Sensing: Parcels, Crates, Agents
// ==========================================

socket.onSensing((sensing) => {
  for (const parcel of sensing.parcels ?? []) {
    beliefState.parcels.set(parcel.id, parcel);
  }

  for (const crate of sensing.crates ?? []) {
    beliefState.crates.set(crate.id, crate);
  }

  if (Array.isArray(sensing.agents)) {
    for (const agent of sensing.agents) {
      if (agent.id === beliefState.me.id) continue;
      beliefState.agents.set(agent.id, agent);
    }

    const sensedIdsAgents = new Set(sensing.agents.map((a) => a.id));
    for (const knownAgent of beliefState.agents.values()) {
      if (!sensedIdsAgents.has(knownAgent.id)) {
        beliefState.agents.delete(knownAgent.id);
      }
    }
  }

  const sensedIdsCrates = new Set((sensing.crates ?? []).map((crate) => crate.id));
  for (const knownCrate of beliefState.crates.values()) {
    if (!sensedIdsCrates.has(knownCrate.id)) {
      beliefState.crates.delete(knownCrate.id);
    }
  }

  const sensedIdsParcels = new Set((sensing.parcels ?? []).map((parcel) => parcel.id));
  for (const knownParcel of beliefState.parcels.values()) {
    if (!sensedIdsParcels.has(knownParcel.id)) {
      beliefState.parcels.delete(knownParcel.id);
    }
  }

  beliefState.onUpdate?.();
});