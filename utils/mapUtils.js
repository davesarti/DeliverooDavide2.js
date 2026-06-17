import { STALENESS_WEIGHT } from "./constants.js";

// ==========================================
// Grid and movement helpers
// ==========================================

export const DIRECTIONS = [
  { dx: 1, dy: 0, move: "right" },
  { dx: -1, dy: 0, move: "left" },
  { dx: 0, dy: 1, move: "up" },
  { dx: 0, dy: -1, move: "down" },
];

/*
 * Opposite of each move. A distance map built by BFS expanding OUT from a target
 * tile must be read in the agent's real travel direction — toward the target,
 * the reverse of the expansion — so arrow tiles are honored for the direction
 * the agent actually moves.
 */
export const REVERSE_MOVE = {
  right: "left",
  left: "right",
  up: "down",
  down: "up",
};

/*
 * Checks whether a cell can be entered with a given move.
 * Handles walls and directional tiles.
 */
export function canEnterTile(tileValue, move) {
  if (Number(tileValue) === 0) {
    return false;
  }

  if (tileValue === "↓" && move === "up") return false;
  if (tileValue === "↑" && move === "down") return false;
  if (tileValue === "→" && move === "left") return false;
  if (tileValue === "←" && move === "right") return false;

  return true;
}

/*
 * Manhattan distance between two grid positions.
 */
export function distance({ x: x1, y: y1 }, { x: x2, y: y2 }) {
  const dx = Math.abs(Math.round(x1) - Math.round(x2));
  const dy = Math.abs(Math.round(y1) - Math.round(y2));
  return dx + dy;
}

/*
 * Checks whether a position is occupied by at least one object in the given Map.
 */
export function isOccupied(x, y, objects) {
  for (const obj of objects.values()) {
    if (
      Math.round(obj.x) === x &&
      Math.round(obj.y) === y
    ) {
      return true;
    }
  }

  return false;
}

export function isInsideMap(x, y, map) {
  if (
    map &&
    Array.isArray(map.grid) &&
    map.grid.length > 0 &&
    Array.isArray(map.grid[0])
  ) {
    return (
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      x >= 0 &&
      y >= 0 &&
      y < map.grid.length &&
      x < map.grid[0].length
    );
  }

  if (Array.isArray(map)) {
    return (
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      map.length > 0 &&
      Array.isArray(map[0]) &&
      x >= 0 &&
      y >= 0 &&
      y < map.length &&
      x < map[0].length
    );
  }

  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    y >= 0 &&
    x < map.width &&
    y < map.height
  );
}

export function isBlockedTile(x, y, blockedTiles = new Set()) {
  return blockedTiles.has(`${x},${y}`);
}

/*
 * Set of tile keys ("x,y") currently observable by the agent.
 * Mirrors the server's sensing (a BFS over walkable tiles bounded by
 * observation_distance), so beliefs can distinguish "absent from the
 * snapshot because gone" (negative evidence, inside this set) from "absent
 * because out of range" (no evidence: keep the belief).
 * Returns null when everything is observable (no finite observation
 * distance), which reproduces plain snapshot semantics.
 */
export function computeObservableTiles(me, grid, observationDistance) {
  if (observationDistance == null || !Number.isFinite(observationDistance)) {
    return null;
  }
  if (!Array.isArray(grid) || grid.length === 0) return null;

  const startX = Math.round(me.x);
  const startY = Math.round(me.y);
  if (!isInsideMap(startX, startY, grid)) return null;

  const observable = new Set([`${startX},${startY}`]);
  let frontier = [{ x: startX, y: startY }];

  for (let depth = 0; depth < observationDistance && frontier.length > 0; depth++) {
    const next = [];

    for (const cell of frontier) {
      for (const { dx, dy } of DIRECTIONS) {
        const nx = cell.x + dx;
        const ny = cell.y + dy;
        const key = `${nx},${ny}`;

        if (observable.has(key)) continue;
        if (!isInsideMap(nx, ny, grid)) continue;
        if (Number(grid[ny][nx]) === 0) continue;

        observable.add(key);
        next.push({ x: nx, y: ny });
      }
    }

    frontier = next;
  }

  return observable;
}

export function canUseNeighborTile({
  x,
  y,
  move,
  map,
  crates = new Map(),
  agents = new Map(),
  blockedTiles = new Set(),
}) {
  if (!isInsideMap(x, y, map)) return false;
  if (isBlockedTile(x, y, blockedTiles)) return false;
  if (!canEnterTile(map[y][x], move)) return false;
  if (isOccupied(x, y, crates)) return false;
  if (isOccupied(x, y, agents)) return false;

  return true;
}
// ==========================================
// Spawn exploration
// ==========================================

function gaussianWeight(distanceFromAgent, sigma) {
  return Math.exp(
    -(distanceFromAgent * distanceFromAgent) / (2 * sigma * sigma)
  );
}

/*
 * Updates the staleness level of spawn tiles.
 * A spawn tile far from sensing becomes more interesting.
 * A spawn tile nearby, just checked, becomes less interesting.
 */
export function updateSpawnStaleness(me, spawnTiles, observationDistance) {
  if (observationDistance === undefined || observationDistance == null) return;

  const sigma = observationDistance / 2;

  for (const tile of spawnTiles) {
    const manhattanDist =
      Math.abs(tile.x - me.x) + Math.abs(tile.y - me.y);

    if (manhattanDist === 0) {
      tile.staleness = 0;
      continue;
    }

    const weight = gaussianWeight(manhattanDist, sigma);
    const current = tile.staleness ?? 0;

    if (manhattanDist <= observationDistance) {
      tile.staleness = Math.max(0, current - weight);
    } else {
      tile.staleness = current + (1 - weight);
    }
  }
}

/*
 * Sorts spawn tiles to explore.
 * Combines two criteria:
 * - high staleness: tile not checked for the longest time
 * - low distance: most convenient tile to reach
 */
export function findCellsToExplore(spawnTiles, me) {
  const candidates = spawnTiles.filter(
    (tile) =>
      !(tile.x === Math.round(me.x) && tile.y === Math.round(me.y))
  );

  if (candidates.length === 0) return [];

  const maxStaleness =
    Math.max(...candidates.map((tile) => tile.staleness ?? 0)) || 1;

  const maxDist =
    Math.max(...candidates.map((tile) => distance(tile, me))) || 1;

  candidates.sort((a, b) => {
    const scoreA =
      STALENESS_WEIGHT * ((a.staleness ?? 0) / maxStaleness) +
      (1 - STALENESS_WEIGHT) * (1 - distance(a, me) / maxDist);

    const scoreB =
      STALENESS_WEIGHT * ((b.staleness ?? 0) / maxStaleness) +
      (1 - STALENESS_WEIGHT) * (1 - distance(b, me) / maxDist);

    return scoreB - scoreA;
  });

  return candidates;
}

/*
 * Checks whether a position corresponds to a delivery tile.
 */
export function isDeliveryTile(x, y, deliveryTiles) {
  return deliveryTiles.some(
    (tile) =>
      Math.round(tile.x) === Math.round(x) &&
      Math.round(tile.y) === Math.round(y)
  );
}