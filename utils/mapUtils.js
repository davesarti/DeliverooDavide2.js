import {
  MOVING_WINDOW_MS,
  STALENESS_WEIGHT,
} from "./constants.js";

// ==========================================
// Movement and reward estimation
// ==========================================

let tilesPerSecond = 10.0;

const movementStats = {
  lastX: null,
  lastY: null,
  lastTimeMs: null,
  samples: [],
  lastReportMs: 0,
};

/*
 * Aggiorna una stima della velocità reale dell'agente.
 * Serve per stimare quanta reward perderà un pacco durante uno spostamento.
 */
export function updateTilesPerSecond(x, y) {
  const nowMs = Date.now();

  if (movementStats.lastTimeMs === null) {
    movementStats.lastX = x;
    movementStats.lastY = y;
    movementStats.lastTimeMs = nowMs;
    return;
  }

  const dx = Math.abs(x - movementStats.lastX);
  const dy = Math.abs(y - movementStats.lastY);
  const movedTiles = dx + dy;

  movementStats.samples.push({
    timeMs: nowMs,
    tiles: movedTiles,
  });

  const cutoffMs = nowMs - MOVING_WINDOW_MS;

  while (
    movementStats.samples.length > 0 &&
    movementStats.samples[0].timeMs < cutoffMs
  ) {
    movementStats.samples.shift();
  }

  if (
    nowMs - movementStats.lastReportMs >= 1000 &&
    movementStats.samples.length > 0
  ) {
    const windowTiles = movementStats.samples.reduce(
      (sum, sample) => sum + sample.tiles,
      0
    );

    const windowDurationMs = Math.max(
      nowMs - movementStats.samples[0].timeMs,
      1
    );

    const computedTilesPerSecond =
      windowTiles / (windowDurationMs / 1000);

    tilesPerSecond = Number(computedTilesPerSecond.toFixed(2));
    movementStats.lastReportMs = nowMs;
  }

  movementStats.lastX = x;
  movementStats.lastY = y;
  movementStats.lastTimeMs = nowMs;
}

/*
 * Restituisce la velocità stimata dell'agente in tile al secondo.
 */
export function getTilesPerSecond() {
  return tilesPerSecond;
}

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
 * Controlla se una cella può essere attraversata con una certa mossa.
 * Gestisce muri e tile direzionali.
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
 * Distanza Manhattan tra due posizioni della griglia.
 */
export function distance({ x: x1, y: y1 }, { x: x2, y: y2 }) {
  const dx = Math.abs(Math.round(x1) - Math.round(x2));
  const dy = Math.abs(Math.round(y1) - Math.round(y2));
  return dx + dy;
}

/*
 * Controlla se una posizione è occupata da almeno un oggetto nella Map passata.
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

// ==========================================
// Spawn exploration
// ==========================================

function gaussianWeight(distanceFromAgent, sigma) {
  return Math.exp(
    -(distanceFromAgent * distanceFromAgent) / (2 * sigma * sigma)
  );
}

/*
 * Aggiorna il livello di "staleness" delle spawn tile.
 * Una spawn tile lontana dal sensing diventa più interessante.
 * Una spawn tile vicina, quindi appena controllata, diventa meno interessante.
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
 * Ordina le spawn tile da esplorare.
 * Combina due criteri:
 * - staleness alta: tile non controllata da più tempo
 * - distanza bassa: tile più comoda da raggiungere
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