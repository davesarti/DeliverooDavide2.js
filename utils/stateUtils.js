/*
 * Finds the nearest reachable delivery tile from a position.
 */
export function nearestDeliveryTileAt(position, deliveryDistanceMap) {
  const row = deliveryDistanceMap?.[Math.round(position.y)];
  const entries = row?.[Math.round(position.x)];

  if (!Array.isArray(entries) || entries.length === 0) return null;

  let best = null;

  for (const entry of entries) {
    if (!Number.isFinite(entry.distance)) continue;

    if (!best || entry.distance < best.distance) {
      best = entry;
    }
  }

  if (!best) return null;

  return {
    tile: {
      x: best.deliveryX,
      y: best.deliveryY,
    },
    distance: best.distance,
  };
}

/*
 * Reads from the deliveryDistanceMap the distance between a position
 * and a specific delivery tile.
 */
export function deliveryMapDistance(deliveryDistanceMap, from, target) {
  const row = deliveryDistanceMap?.[Math.round(from.y)];
  const entries = row?.[Math.round(from.x)];

  if (!Array.isArray(entries)) return null;

  const entry = entries.find(
    (candidate) =>
      candidate.deliveryX === Math.round(target.x) &&
      candidate.deliveryY === Math.round(target.y)
  );

  if (!entry || !Number.isFinite(entry.distance)) return null;

  return entry.distance;
}

/*
 * Reads from the spawnDistanceMap the distance between a position
 * and a specific spawn tile.
 */
export function spawnMapDistance(spawnDistanceMap, from, target) {
  const row = spawnDistanceMap?.[Math.round(from.y)];
  const entries = row?.[Math.round(from.x)];

  if (!Array.isArray(entries)) return null;

  const entry = entries.find(
    (candidate) =>
      candidate.spawnX === Math.round(target.x) &&
      candidate.spawnY === Math.round(target.y)
  );

  if (!entry || !Number.isFinite(entry.distance)) return null;

  return entry.distance;
}

/*
 * Converts a duration expressed as a server string into milliseconds.
 * Supports formats like "1s", "500ms", "2s".
 * Exported for the event-based decay model (utils/decayModel.js).
 */
export function parseDurationMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().toLowerCase();

  if (trimmed.endsWith("ms")) {
    const number = Number(trimmed.slice(0, -2));
    return Number.isFinite(number) ? number : null;
  }

  if (trimmed.endsWith("s")) {
    const number = Number(trimmed.slice(0, -1));
    return Number.isFinite(number) ? number * 1000 : null;
  }

  const number = Number(trimmed);
  return Number.isFinite(number) ? number : null;
}
