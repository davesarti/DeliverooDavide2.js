import { nearestDeliveryTileAt, spawnMapDistance } from "../utils/stateUtils.js";
import { distance, getTilesPerSecond } from "../utils/mapUtils.js";
import { PARCEL_DECAY } from "../utils/constants.js";

export const EXPLORATION_INCENTIVE = 0.01;
export const DROP_DISINCENTIVE = 0;

/*
 * Traduce la velocità dell'agente nel costo stimato del decay.
 * Richiede bs per identificare l'agente corretto nella Map di velocità condivisa.
 */
export function distanceFactor(bs = null) {
  const agentId = bs?.me?.id ?? "default";
  const tilesPerSec = getTilesPerSecond(agentId);
  if (!tilesPerSec || tilesPerSec <= 0) return 0;
  return PARCEL_DECAY / tilesPerSec;
}

/*
 * Stima quanto costa prendere un pacco e portarlo fino alla delivery più vicina.
 */
export function pickupRouteDistance(parcel, me, bs) {
  const nearest = nearestDeliveryTileAt(
    { x: parcel.x, y: parcel.y },
    bs.map.deliveryDistanceMap
  );
  if (!nearest) return null;

  const pickupDist =
    spawnMapDistance(
      bs.map.spawnDistanceMap,
      { x: me.x, y: me.y },
      { x: parcel.x, y: parcel.y }
    ) ?? distance({ x: parcel.x, y: parcel.y }, { x: me.x, y: me.y });

  return pickupDist + nearest.distance;
}

/*
 * Genera i pickup che valgono ancora la pena nello stato corrente.
 */
function generatePickupOptions(parcels, me, bs) {
  const deliveryDistanceMap = bs.map.deliveryDistanceMap;
  if (!Array.isArray(deliveryDistanceMap) || deliveryDistanceMap.length === 0) return null;

  const pickupOptions = [];

  for (const parcel of parcels.values()) {
    if (parcel.carriedBy) continue;

    const routeDist = pickupRouteDistance(parcel, me, bs);
    if (routeDist == null) continue;

    const expectedScore = parcel.reward - routeDist * distanceFactor(bs);
    if (expectedScore > 0) {
      pickupOptions.push(["go_pick_up", parcel.x, parcel.y, parcel.id]);
    }
  }

  return pickupOptions;
}

/*
 * Genera le consegne disponibili per i pacchi già trasportati.
 */
function generateDeliveryOptions(parcels, me, bs) {
  const deliveryDistanceMap = bs.map.deliveryDistanceMap;
  if (!Array.isArray(deliveryDistanceMap) || deliveryDistanceMap.length === 0) return [];

  const carries = Array.from(parcels.values()).some((p) => p.carriedBy === me.id);
  if (!carries) return [];

  const row = deliveryDistanceMap[Math.round(me.y)];
  const entries = row?.[Math.round(me.x)];
  if (!Array.isArray(entries) || entries.length === 0) return [];

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

/*
 * Aggiorna la coda delle intenzioni con opzioni sensate per il momento.
 */
export function optionsGeneration(agent, bs) {
  const { me, parcels } = bs;
  const deliveryDistanceMap = bs.map.deliveryDistanceMap;

  if (
    !me?.id ||
    me.x == null ||
    me.y == null ||
    !Array.isArray(deliveryDistanceMap) ||
    deliveryDistanceMap.length === 0
  ) {
    return;
  }

  const isFailedIntention = (predicate) =>
    typeof agent?.isPredicateInFailedPool === "function" &&
    agent.isPredicateInFailedPool(predicate);

  for (const option of generatePickupOptions(parcels, me, bs) ?? []) {
    if (!isFailedIntention(option)) agent.push(option);
  }

  for (const option of generateDeliveryOptions(parcels, me, bs)) {
    if (!isFailedIntention(option)) agent.push(option);
  }
}