import {
  distance,
  getTilesPerSecond,
} from "./mapUtils.js";

import { PARCEL_DECAY } from "./constants.js";

/*
 * Returns a minimal version of a parcel.
 * Useful when only position and reward are needed, without extra computations.
 */
export function formatParcelBasic(parcel) {
  return {
    id: parcel.id,
    x: Math.round(parcel.x),
    y: Math.round(parcel.y),
    reward: parcel.reward,
  };
}

/*
 * Sorts delivery tiles relative to a position.
 * Used to find which delivery points are most convenient from the current position.
 */
export function buildNearbyDeliveryTiles(position, deliveryTiles) {
  return deliveryTiles
    .map((tile) => ({
      x: tile.x,
      y: tile.y,
      distanceFromPosition: distance(position, tile),
    }))
    .sort((a, b) => a.distanceFromPosition - b.distanceFromPosition);
}

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
 * Enriches a free parcel with data useful for planning.
 * Does not decide what to do: adds distance from the player and some delivery candidates.
 */
export function enrichParcelForDecision(
  parcel,
  me,
  deliveryDistanceMap,
  {
    maxDeliveryOptions = 3,
    parcelDecayingEvent = null,
    agentId = "default",
  } = {}
) {
  const deliveryOptions = buildParcelDeliveryOptions(
    { x: parcel.x, y: parcel.y },
    deliveryDistanceMap,
    parcel.reward,
    parcelDecayingEvent,
    agentId
  ).slice(0, maxDeliveryOptions);

  return {
    id: parcel.id,
    x: Math.round(parcel.x),
    y: Math.round(parcel.y),
    reward: parcel.reward,
    distanceToMe: distance(me, parcel),
    rewardLossPerTile: getRewardLossPerTile(parcelDecayingEvent, agentId),
    deliveryOptions,
  };
}

/*
 * Builds delivery candidates for a parcel.
 * For each reachable delivery, computes distance and estimated reward at delivery.
 */
function buildParcelDeliveryOptions(position, deliveryDistanceMap, parcelReward, parcelDecayingEvent, agentId = "default") {
  const row = deliveryDistanceMap?.[Math.round(position.y)];
  const entries = row?.[Math.round(position.x)];

  if (!Array.isArray(entries)) return [];

  const rewardLossPerTile = getRewardLossPerTile(parcelDecayingEvent, agentId);

  return entries
    .filter((entry) => Number.isFinite(entry.distance))
    .map((entry) => ({
      x: entry.deliveryX,
      y: entry.deliveryY,
      distanceFromParcel: entry.distance,
      estimatedRewardAtDelivery: Math.max(
        0,
        parcelReward - entry.distance * rewardLossPerTile
      ),
    }))
    .sort((a, b) => {
      if (b.estimatedRewardAtDelivery !== a.estimatedRewardAtDelivery) {
        return b.estimatedRewardAtDelivery - a.estimatedRewardAtDelivery;
      }

      return a.distanceFromParcel - b.distanceFromParcel;
    });
}

/*
 * Converts a duration expressed as a server string into milliseconds.
 * Supports formats like "1s", "500ms", "2s".
 */
function parseDurationMs(value) {
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

/*
 * Returns how much reward a parcel loses per second.
 * Uses parcels.decaying_event from the server; if missing, uses PARCEL_DECAY as fallback.
 */
function getParcelDecayPerSecond(parcelDecayingEvent) {
  const decayEventMs = parseDurationMs(parcelDecayingEvent);
  if (!decayEventMs || decayEventMs <= 0) return PARCEL_DECAY;
  return 1000 / decayEventMs;
}

/*
 * Estimates how much reward is lost per tile traveled.
 * agentId identifies the correct agent in the shared speed Map.
 */
export function getRewardLossPerTile(parcelDecayingEvent, agentId = "default") {
  const tilesPerSecond = getTilesPerSecond(agentId);
  if (!tilesPerSecond || tilesPerSecond <= 0) return 0;
  return getParcelDecayPerSecond(parcelDecayingEvent) / tilesPerSecond;
}