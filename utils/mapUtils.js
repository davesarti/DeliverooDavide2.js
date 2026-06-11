import {
  MOVING_WINDOW_MS,
  STALENESS_WEIGHT,
} from "./constants.js";

// ==========================================
// Movement and reward estimation
// ==========================================

/*
 * Mappa per-agente: agentId → { tilesPerSecond, lastX, lastY, lastTimeMs, samples, lastReportMs }
 * Necessario in modalità BOTH dove BDI e LLM possono avere velocità diverse.
 */
const _agentMovementStats = new Map();

function _getOrCreateStats(agentId) {
  if (!_agentMovementStats.has(agentId)) {
    _agentMovementStats.set(agentId, {
      tilesPerSecond: 10.0,
      lastX: null,
      lastY: null,
      lastTimeMs: null,
      samples: [],
      lastReportMs: 0,
    });
  }
  return _agentMovementStats.get(agentId);
}

/*
 * Aggiorna la stima della velocità reale per uno specifico agente.
 * agentId deve essere bs.me.id; se non disponibile usa 'default'.
 */
export function updateTilesPerSecond(x, y, agentId = "default") {
  const stats = _getOrCreateStats(agentId);
  const nowMs = Date.now();

  if (stats.lastTimeMs === null) {
    stats.lastX = x;
    stats.lastY = y;
    stats.lastTimeMs = nowMs;
    return;
  }

  const dx = Math.abs(x - stats.lastX);
  const dy = Math.abs(y - stats.lastY);
  const movedTiles = dx + dy;

  stats.samples.push({ timeMs: nowMs, tiles: movedTiles });

  const cutoffMs = nowMs - MOVING_WINDOW_MS;
  while (stats.samples.length > 0 && stats.samples[0].timeMs < cutoffMs) {
    stats.samples.shift();
  }

  if (nowMs - stats.lastReportMs >= 1000 && stats.samples.length > 0) {
    const windowTiles = stats.samples.reduce((sum, s) => sum + s.tiles, 0);
    const windowDurationMs = Math.max(nowMs - stats.samples[0].timeMs, 1);
    stats.tilesPerSecond = Number(
      (windowTiles / (windowDurationMs / 1000)).toFixed(2)
    );
    stats.lastReportMs = nowMs;
  }

  stats.lastX = x;
  stats.lastY = y;
  stats.lastTimeMs = nowMs;
}

/*
 * Restituisce la velocità stimata in tile/s per uno specifico agente.
 * agentId deve essere bs.me.id; se non disponibile usa 'default'.
 */
export function getTilesPerSecond(agentId = "default") {
  return _getOrCreateStats(agentId).tilesPerSecond;
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

export function isInsideMap(x, y, map) {
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

/*
 * Controlla se una posizione corrisponde a una delivery tile.
 */
export function isDeliveryTile(x, y, deliveryTiles) {
  return deliveryTiles.some(
    (tile) =>
      Math.round(tile.x) === Math.round(x) &&
      Math.round(tile.y) === Math.round(y)
  );
}