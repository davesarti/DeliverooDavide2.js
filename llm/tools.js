import { nearestDeliveryTileAt } from "../utils/stateUtils.js";
import { distance } from "../utils/mapUtils.js";
import { callLLMText } from "./client.js";
import { buildPersistentMemoryUpdateMessages } from "./prompts.js";

// ==========================================
// calculate
// ==========================================

/*
 * Valuta un'espressione matematica e restituisce il risultato come stringa.
 * Usato dal mission loop quando le coordinate sono espresse come formule.
 */
export function calculate({ expression }) {
  try {
    // Whitelist: solo caratteri matematici ammessi
    if (!/^[\d\s\+\-\*\/\(\)\.\,]+$/.test(expression)) {
      return `Error: expression contains invalid characters: ${expression}`;
    }

    const result = Function(`"use strict"; return (${expression})`)();

    if (typeof result !== "number" || !isFinite(result)) {
      return `Error: expression did not produce a valid number: ${expression}`;
    }

    return `${expression} = ${result}`;
  } catch (error) {
    return `Error: could not evaluate expression "${expression}": ${error.message}`;
  }
}

// ==========================================
// get_my_position
// ==========================================

/*
 * Legge la posizione corrente dell'agente dal belief state.
 */
export function getMyPosition(bs) {
  const { x, y, id, name, score } = bs.me;

  if (x == null || y == null) {
    return "Error: agent position not available yet.";
  }

  return JSON.stringify({
    id,
    name,
    x: Math.round(x),
    y: Math.round(y),
    score,
  });
}

// ==========================================
// find_delivery_tile
// ==========================================

/*
 * Trova una delivery tile in base a una descrizione testuale.
 * Query supportate: "leftmost", "rightmost", "topmost", "bottommost", "nearest".
 * Restituisce le coordinate della tile trovata come stringa JSON.
 */
export function findDeliveryTile({ query }, bs) {
  const tiles = bs.map.deliveryTiles;

  if (!tiles || tiles.length === 0) {
    return "Error: no delivery tiles available.";
  }

  const normalized = query.trim().toLowerCase();

  let tile = null;

  if (normalized === "leftmost") {
    tile = tiles.reduce((a, b) => (b.x < a.x ? b : a));
  } else if (normalized === "rightmost") {
    tile = tiles.reduce((a, b) => (b.x > a.x ? b : a));
  } else if (normalized === "topmost") {
    tile = tiles.reduce((a, b) => (b.y > a.y ? b : a));
  } else if (normalized === "bottommost") {
    tile = tiles.reduce((a, b) => (b.y < a.y ? b : a));
  } else if (normalized === "nearest") {
    const nearest = nearestDeliveryTileAt(bs.me, bs.map.deliveryDistanceMap);
    if (!nearest) return "Error: could not find nearest delivery tile.";
    tile = nearest.tile;
  } else {
    return `Error: unknown query "${query}". Supported: leftmost, rightmost, topmost, bottommost, nearest.`;
  }

  return JSON.stringify({ x: tile.x, y: tile.y });
}

// ==========================================
// get_environment_state
// ==========================================

/*
 * Restituisce una rappresentazione testuale dello stato attuale dell'ambiente,
 * comprensiva di posizione, punteggio, pacchi trasportati, pacchi visibili e
 * tile di consegna vicine. Usato come input per l'LLM.
 */

export function get_environment_state(bs) {
  const me = bs.me;

  const carriedParcels = [...bs.parcels.values()]
    .filter((parcel) => parcel.carriedBy === me.id)
    .map((parcel) => ({
      id: parcel.id,
      reward: parcel.reward ?? 0,
    }));

  const visibleParcels = [...bs.parcels.values()]
    .filter((parcel) => !parcel.carriedBy)
    .map((parcel) => ({
      id: parcel.id,
      x: Math.round(parcel.x),
      y: Math.round(parcel.y),
      reward: parcel.reward ?? 0,
      distanceToMe: distance(me, parcel),
    }))
    .sort((a, b) => {
      if (b.reward !== a.reward) return b.reward - a.reward;
      return a.distanceToMe - b.distanceToMe;
    })
    .slice(0, 8);

  const deliveryTiles = bs.map.deliveryTiles
    .map((tile) => ({
      x: tile.x,
      y: tile.y,
      distanceToMe: distance(me, tile),
    }))
    .sort((a, b) => a.distanceToMe - b.distanceToMe)
    .slice(0, 5);

  return JSON.stringify({
    me: {
      x: Math.round(me.x),
      y: Math.round(me.y),
      score: me.score,
    },

    carried: {
      count: carriedParcels.length,
      totalReward: carriedParcels.reduce(
        (sum, parcel) => sum + parcel.reward,
        0
      ),
      parcels: carriedParcels,
    },

    visibleParcels,

    deliveryTiles,

    persistentMemory: bs.persistentMemory ?? "None.",
  });
}


// ==========================================
// update_persistent_memory
// ==========================================

export async function updatePersistentMemory(bs, text) {
  const updatedMemory = await callLLMText({
    messages: buildPersistentMemoryUpdateMessages({
      currentMemory: bs.persistentMemory,
      updateRequest: text,
    }),
    temperature: 0,
  });

  bs.persistentMemory = updatedMemory.trim();

  return `Persistent memory updated:\n${bs.persistentMemory || "None"}`;
}