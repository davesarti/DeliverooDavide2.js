export const PARCEL_DECAY = 1;
let tiles_per_sec = 10.0;

export const DIRECTIONS = [
  { dx: 1, dy: 0, move: "right" },
  { dx: -1, dy: 0, move: "left" },
  { dx: 0, dy: 1, move: "up" },
  { dx: 0, dy: -1, move: "down" },
];

export function canEnterTile(tileValue, move) {
    if (Number(tileValue) === 0) {
        return false;
    }

    if (tileValue == '↓' && move === 'up') return false;
    if (tileValue == '↑' && move === 'down') return false;
    if (tileValue == '→' && move === 'left') return false;
    if (tileValue == '←' && move === 'right') return false;

    return true;
}

export function distance({ x: x1, y: y1 }, { x: x2, y: y2 }) {
    const dx = Math.abs(Math.round(x1) - Math.round(x2));
    const dy = Math.abs(Math.round(y1) - Math.round(y2));
    return dx + dy;
}

export function getTilesPerSecond() {
    return tiles_per_sec;
}

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

function gaussianWeight(d, sigma) {
  return Math.exp(-(d * d) / (2 * sigma * sigma));
}

export function findCellsToExplore(spawnTiles, me) {
  const candidates = spawnTiles.filter(
    (tile) => !(tile.x === Math.round(me.x) && tile.y === Math.round(me.y))
  );

  if (candidates.length === 0) return [];

  const maxVisits = Math.max(...candidates.map((tile) => tile.visits ?? 0));
  const maxDist =
    Math.max(...candidates.map((tile) => distance(tile, me))) || 1;

  const W_HEAT = 0.7;

  candidates.sort((a, b) => {
    const scoreA =
      W_HEAT * ((a.visits ?? 0) / maxVisits) +
      (1 - W_HEAT) * (1 - distance(a, me) / maxDist);

    const scoreB =
      W_HEAT * ((b.visits ?? 0) / maxVisits) +
      (1 - W_HEAT) * (1 - distance(b, me) / maxDist);

    return scoreB - scoreA;
  });

  return candidates;
}