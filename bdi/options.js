import { beliefState } from "../beliefs/beliefState.js";
import {
  distance,
  PARCEL_DECAY,
  getTilesPerSecond,
} from "../utils/mapUtils.js";

function distanceFactor() {
  const tilesPerSec = getTilesPerSecond();

  if (!tilesPerSec || tilesPerSec <= 0) {
    return 0;
  }

  return PARCEL_DECAY / tilesPerSec;
}

export function generateOptions() {
  const me = beliefState.me;
  const parcels = beliefState.parcels;
  const deliveryDistanceMap = beliefState.map.deliveryDistanceMap;
  const spawnDistanceMap = beliefState.map.spawnDistanceMap;

  if (
    !me?.id ||
    me.x == null ||
    me.y == null ||
    !Array.isArray(deliveryDistanceMap) ||
    deliveryDistanceMap.length === 0
  ) {
    return [];
  }

  return [
    ...generatePickupOptions({
      parcels,
      me,
      deliveryDistanceMap,
      spawnDistanceMap,
    }),

    ...generateDeliveryOptions({
      parcels,
      me,
      deliveryDistanceMap,
    }),

    ["explore"],
  ];
}

function generatePickupOptions({
  parcels,
  me,
  deliveryDistanceMap,
  spawnDistanceMap,
}) {
  const options = [];

  for (const parcel of parcels.values()) {
    if (parcel.carriedBy) continue;

    const routeDistance = pickupRouteDistance({
      parcel,
      me,
      deliveryDistanceMap,
      spawnDistanceMap,
    });

    if (routeDistance == null) continue;

    const estimatedValue = parcel.reward - routeDistance * distanceFactor();

    if (estimatedValue > 0) {
      options.push(["go_pick_up", parcel.x, parcel.y, parcel.id]);
    }
  }

  return options;
}

function generateDeliveryOptions({ parcels, me, deliveryDistanceMap }) {
  const carried = [...parcels.values()].some(
    (parcel) => parcel.carriedBy === me.id
  );

  if (!carried) return [];

  const row = deliveryDistanceMap?.[Math.round(me.y)];
  const entries = row?.[Math.round(me.x)];

  if (!Array.isArray(entries)) return [];

  const options = [];
  const seen = new Set();

  for (const entry of entries) {
    if (!Number.isFinite(entry.distance)) continue;

    const key = `${entry.deliveryX},${entry.deliveryY}`;
    if (seen.has(key)) continue;

    seen.add(key);
    options.push(["go_drop_off", entry.deliveryX, entry.deliveryY]);
  }

  return options;
}

function pickupRouteDistance({
  parcel,
  me,
  deliveryDistanceMap,
  spawnDistanceMap,
}) {
  const nearest = nearestDeliveryTileAt(
    { x: parcel.x, y: parcel.y },
    deliveryDistanceMap
  );

  if (!nearest) return null;

  const pickupDistance =
    spawnMapDistance(
      spawnDistanceMap,
      { x: me.x, y: me.y },
      { x: parcel.x, y: parcel.y }
    ) ??
    distance(
      { x: parcel.x, y: parcel.y },
      { x: me.x, y: me.y }
    );

  return pickupDistance + nearest.distance;
}

function nearestDeliveryTileAt({ x, y }, deliveryDistanceMap) {
  const row = deliveryDistanceMap?.[Math.round(y)];
  const entries = row?.[Math.round(x)];

  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }

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

function spawnMapDistance(spawnDistanceMap, from, target) {
  const row = spawnDistanceMap?.[Math.round(from.y)];
  const entries = row?.[Math.round(from.x)];

  if (!Array.isArray(entries)) {
    return null;
  }

  const entry = entries.find(
    (candidate) =>
      candidate.spawnX === Math.round(target.x) &&
      candidate.spawnY === Math.round(target.y)
  );

  if (!entry || !Number.isFinite(entry.distance)) {
    return null;
  }

  return entry.distance;
}