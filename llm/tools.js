import { nearestDeliveryTileAt } from "../utils/stateUtils.js";
import { distance, isInsideMap } from "../utils/mapUtils.js";
import { callLLMText } from "./client.js";
import { buildPersistentMemoryUpdateMessages } from "./prompts.js";

// ==========================================
// calculate
// ==========================================

/*
 * Evaluates a mathematical expression and returns the result as a string.
 * Used by the mission loop when coordinates are expressed as formulas.
 */
export function calculate({ expression }) {
  try {
    // Whitelist: only mathematical characters allowed
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
 * Reads the current agent position from the belief state.
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
 * Finds a delivery tile based on a textual description.
 * Supported queries: "leftmost", "rightmost", "topmost", "bottommost", "nearest".
 * Returns the coordinates of the found tile as a JSON string.
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
 * Returns a textual representation of the current environment state,
 * including position, score, carried parcels, visible parcels and
 * nearby delivery tiles. Used as input for the LLM.
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

/*
 * Updates the persistent memory with new rules or information.
 * The persistent memory is a string the LLM can read at each iteration
 * to maintain durable knowledge or behavior rules.
 * The input text should be a clear update request, for example
 * "From now on, always prioritize parcels with reward above 5" or "Never go to the top-right corner".
 * The function returns the updated persistent memory after the update.
 */
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

// ==========================================
// block_tile / unblock_tile
// ==========================================

/*
 * Tools for blocking or unblocking a specific tile for pathfinding.
 * Useful for imposing dynamic navigation constraints.
 */

export function blockTile({ x, y }, bs) {
  if (!isInsideMap(x, y, bs.map)) {
    return `Error: tile (${x}, ${y}) is outside the map.`;
  }

  const key = `${x},${y}`;

  if (bs.map.blockedTiles.has(key)) {
    return `Tile (${x}, ${y}) is already blocked for pathfinding.`;
  }

  bs.map.blockedTiles.add(key);

  return `Tile (${x}, ${y}) is now blocked for pathfinding.`;
}

export function unblockTile({ x, y }, bs) {
  if (!isInsideMap(x, y, bs.map)) {
    return `Error: tile (${x}, ${y}) is outside the map.`;
  }

  const key = `${x},${y}`;

  if (!bs.map.blockedTiles.has(key)) {
    return `Tile (${x}, ${y}) was not blocked.`;
  }

  bs.map.blockedTiles.delete(key);

  return `Tile (${x}, ${y}) is now walkable again for pathfinding.`;
}