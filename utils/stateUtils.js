import { distance } from "./mapUtils.js";

/*
 * Restituisce una versione minima di un pacco.
 * È utile quando non servono informazioni di pathfinding o stime.
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
 * Cerca la delivery raggiungibile più vicina a una posizione.
 * Usa la mappa precalcolata delle distanze statiche verso le delivery.
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
 * Legge dalla deliveryDistanceMap la distanza tra una posizione
 * e una specifica delivery tile.
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
 * Legge dalla spawnDistanceMap la distanza tra una posizione
 * e una specifica spawn tile.
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
 * Costruisce una descrizione arricchita di un pacco.
 * Serve sia al BDI per stimare convenienza, sia all'LLM per ragionare.
 */
export function enrichParcelForDecision(parcel, me, deliveryDistanceMap) {
  const nearestDelivery = nearestDeliveryTileAt(
    { x: parcel.x, y: parcel.y },
    deliveryDistanceMap
  );

  const distanceToMe = distance(me, parcel);
  const distanceToNearestDelivery = nearestDelivery?.distance ?? null;

  const estimatedRewardAtDelivery =
    distanceToNearestDelivery == null
      ? null
      : Math.max(0, parcel.reward - distanceToNearestDelivery);

  return {
    id: parcel.id,
    x: Math.round(parcel.x),
    y: Math.round(parcel.y),
    reward: parcel.reward,
    distanceToMe,
    nearestDelivery: nearestDelivery?.tile ?? null,
    distanceToNearestDelivery,
    estimatedRewardAtDelivery,
  };
}