import {
  distance,
  getTilesPerSecond,
} from "./mapUtils.js";

import { PARCEL_DECAY } from "./constants.js";

/*
 * Restituisce una versione minima di un pacco.
 * Utile quando servono solo posizione e reward, senza calcoli aggiuntivi.
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
 * Ordina le delivery rispetto a una posizione.
 * Serve per sapere quali punti di consegna sono più comodi dalla posizione attuale.
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
 * Cerca la delivery raggiungibile più vicina a una posizione.
 * La teniamo per compatibilità con logiche semplici o future parti BDI.
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
 * Arricchisce un pacco libero con dati utili alla pianificazione.
 * Non sceglie cosa fare: aggiunge distanza dal player e alcune delivery candidate.
 */
export function enrichParcelForDecision(
  parcel,
  me,
  deliveryDistanceMap,
  {
    maxDeliveryOptions = 3,
  } = {}
) {
  const deliveryOptions = buildParcelDeliveryOptions(
    { x: parcel.x, y: parcel.y },
    deliveryDistanceMap,
    parcel.reward
  ).slice(0, maxDeliveryOptions);

  return {
    id: parcel.id,
    x: Math.round(parcel.x),
    y: Math.round(parcel.y),
    reward: parcel.reward,
    distanceToMe: distance(me, parcel),
    rewardLossPerTile: getRewardLossPerTile(),
    deliveryOptions,
  };
}

/*
 * Costruisce le delivery candidate per un pacco.
 * Per ogni delivery raggiungibile calcola distanza e reward stimata alla consegna.
 */
function buildParcelDeliveryOptions(position, deliveryDistanceMap, parcelReward) {
  const row = deliveryDistanceMap?.[Math.round(position.y)];
  const entries = row?.[Math.round(position.x)];

  if (!Array.isArray(entries)) return [];

  const rewardLossPerTile = getRewardLossPerTile();

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
 * Stima quanta reward viene persa per ogni tile percorsa.
 * Usa il decay del pacco e la velocità recente dell'agente.
 */
function getRewardLossPerTile() {
  const tilesPerSecond = getTilesPerSecond();

  if (!tilesPerSecond || tilesPerSecond <= 0) {
    return 0;
  }

  return PARCEL_DECAY / tilesPerSecond;
}