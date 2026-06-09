import { beliefState } from "../beliefs/beliefState.js";
import { nearestDeliveryTileAt, spawnMapDistance } from "../utils/stateUtils.js";
import { distance, getTilesPerSecond } from "../utils/mapUtils.js";
import { PARCEL_DECAY } from "../utils/constants.js";

// BDI-specific tuning constants (not shared with LLM agent).
export const EXPLORATION_INCENTIVE = 0.01;
export const DROP_DISINCENTIVE = 0;

/*
 * Stima quanta reward perde ogni tile percorsa.
 * Combina il decay reale (da config del server o fallback) con la velocità stimata.
 */
export function distanceFactor() {
  const tilesPerSec = getTilesPerSecond();
  if (!tilesPerSec || tilesPerSec <= 0) return 0;
  return PARCEL_DECAY / tilesPerSec;
}

/*
 * Distanza stimata del ciclo completo: agente → pacco → delivery più vicina.
 * Usa la spawnDistanceMap quando disponibile, cade su Manhattan altrimenti.
 */
export function pickupRouteDistance(parcel, me) {
  const nearest = nearestDeliveryTileAt(
    { x: parcel.x, y: parcel.y },
    beliefState.map.deliveryDistanceMap
  );
  if (!nearest) return null;

  const pickupDist =
    spawnMapDistance(
      beliefState.map.spawnDistanceMap,
      { x: me.x, y: me.y },
      { x: parcel.x, y: parcel.y }
    ) ?? distance({ x: parcel.x, y: parcel.y }, { x: me.x, y: me.y });

  return pickupDist + nearest.distance;
}

/*
 * Genera le opzioni di pickup tra i pacchi liberi visibili.
 * Scarta i pacchi il cui score atteso (reward - costo del percorso) è negativo.
 */
function generatePickupOptions(parcels, me) {
  const deliveryDistanceMap = beliefState.map.deliveryDistanceMap;
  if (!Array.isArray(deliveryDistanceMap) || deliveryDistanceMap.length === 0) return null;

  const pickupOptions = [];

  for (const parcel of parcels.values()) {
    if (parcel.carriedBy) continue;

    const routeDist = pickupRouteDistance(parcel, me);
    if (routeDist == null) continue;

    const expectedScore = parcel.reward - routeDist * distanceFactor();
    if (expectedScore > 0) {
      pickupOptions.push(["go_pick_up", parcel.x, parcel.y, parcel.id]);
    }
  }

  return pickupOptions;
}

/*
 * Genera le opzioni di delivery se l'agente sta trasportando almeno un pacco.
 * Ogni delivery raggiungibile diventa un'opzione distinta.
 */
function generateDeliveryOptions(parcels, me) {
  const deliveryDistanceMap = beliefState.map.deliveryDistanceMap;
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
 * Punto di ingresso principale della generazione opzioni.
 * Viene chiamato ogni volta che il beliefState si aggiorna (onSensing).
 * Fa push sull'agente solo se il predicato non è già in coda o nel pool dei fallimenti.
 */
export function optionsGeneration(agent) {
  const { me, parcels } = beliefState;
  const deliveryDistanceMap = beliefState.map.deliveryDistanceMap;

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

  for (const option of generatePickupOptions(parcels, me) ?? []) {
    if (!isFailedIntention(option)) agent.push(option);
  }

  for (const option of generateDeliveryOptions(parcels, me)) {
    if (!isFailedIntention(option)) agent.push(option);
  }
}
