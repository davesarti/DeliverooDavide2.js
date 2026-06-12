import { distance, isInsideMap, isDeliveryTile } from "../utils/mapUtils.js";
import { nearestDeliveryTileAt } from "../utils/stateUtils.js";

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

export function get_environment_state(bs, llmState) {
  const me = bs.me;
  const rules = llmState.persistentRules ?? {};

  const minReward = rules.parcelFilters?.minReward ?? null;
  const maxReward = rules.parcelFilters?.maxReward ?? null;

  const passesFilter = (reward) => {
    if (minReward != null && reward < minReward) return false;
    if (maxReward != null && reward > maxReward) return false;
    return true;
  };

  const carriedParcels = [...bs.parcels.values()]
    .filter((parcel) => parcel.carriedBy === me.id)
    .map((parcel) => ({
      id: parcel.id,
      reward: parcel.reward ?? 0,
    }));

  // Only parcels that satisfy the active reward filter are returned.
  // Parcels rejected by the filter are omitted entirely so the model
  // never has to evaluate suitability itself.
  const visibleParcels = [...bs.parcels.values()]
    .filter((parcel) => !parcel.carriedBy)
    .filter((parcel) => passesFilter(parcel.reward ?? 0))
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

  const forbidden = rules.forbiddenDeliveryTiles ?? new Set();
  const multipliers = rules.deliveryMultipliers ?? new Map();
  const preferred = rules.preferredDeliveryTiles ?? new Set();

  // Delivery tiles are enriched with the rules attached to each tile and,
  // when a multiplier is set, with the effective reward after the multiplier.
  // Forbidden tiles are dropped so the model is never offered an invalid choice.
  const deliveryTiles = bs.map.deliveryTiles
    .map((tile) => {
      const key = `${tile.x},${tile.y}`;
      const multiplier = multipliers.has(key) ? multipliers.get(key) : null;
      return {
        x: tile.x,
        y: tile.y,
        distanceToMe: distance(me, tile),
        ...(multiplier != null ? { rewardMultiplier: multiplier } : {}),
        ...(preferred.has(key) ? { preferred: true } : {}),
      };
    })
    .filter((tile) => !forbidden.has(`${tile.x},${tile.y}`))
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

    persistentMemory: llmState.persistentMemory ?? "None.",
  });
}


// ==========================================
// formatPersistentRules
// ==========================================

/*
 * Renders persistentRules (the single source of truth) into the
 * human/LLM-readable string stored in llmState.persistentMemory.
 */
export function formatPersistentRules(rules) {
  if (!rules) return "None.";

  const lines = [];

  if (rules.stackSize) {
    const modeLabels = {
      exactly: "exactly",
      at_least: "at least",
      at_most: "at most",
    };
    const label = modeLabels[rules.stackSize.mode] ?? rules.stackSize.mode;
    lines.push(
      `- Deliver only when carrying ${label} ${rules.stackSize.count} parcel(s).`
    );
  }

  const minReward = rules.parcelFilters?.minReward;
  const maxReward = rules.parcelFilters?.maxReward;

  if (minReward != null) {
    lines.push(`- Ignore parcels with reward lower than ${minReward}.`);
  }
  if (maxReward != null) {
    lines.push(`- Ignore parcels with reward higher than ${maxReward}.`);
  }

  for (const key of rules.forbiddenDeliveryTiles ?? []) {
    lines.push(`- Never deliver at tile (${key}).`);
  }

  for (const key of rules.preferredDeliveryTiles ?? []) {
    lines.push(`- Prefer delivering at tile (${key}).`);
  }

  for (const [key, multiplier] of rules.deliveryMultipliers ?? []) {
    lines.push(`- Delivery at tile (${key}) gives ${multiplier}x reward.`);
  }

  for (const key of rules.blockedTiles ?? []) {
    lines.push(`- Navigation: never pass through tile (${key}).`);
  }

  return lines.length > 0 ? lines.join("\n") : "None.";
}

function refreshPersistentMemory(llmState) {
  llmState.persistentMemory = formatPersistentRules(llmState.persistentRules);
}

// ==========================================
// Persistent rule tools (atomic)
// ==========================================

/*
 * Each tool applies exactly one structured change to
 * llmState.persistentRules (the single source of truth),
 * then regenerates the readable persistentMemory string.
 * No LLM call involved: the mission LLM already translated
 * natural language into structured fields via the tool schemas.
 */

function tileKey(x, y) {
  return `${x},${y}`;
}

function validateTile(x, y, bs) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    return `Error: concrete integer coordinates required, received (${x}, ${y}).`;
  }

  if (!isInsideMap(x, y, bs.map)) {
    return `Error: tile (${x}, ${y}) is outside the map.`;
  }

  return null;
}

function validateDeliveryTile(x, y, bs) {
  const tileError = validateTile(x, y, bs);
  if (tileError) return tileError;

  if (!isDeliveryTile(x, y, bs.map.deliveryTiles)) {
    return `Error: tile (${x}, ${y}) is not a delivery tile.`;
  }

  return null;
}

/*
 * A delivery tile can hold at most one rule among
 * forbidden / preferred / multiplier: the newest set wins.
 */
function clearDeliveryTileRules(rules, key) {
  rules.forbiddenDeliveryTiles.delete(key);
  rules.preferredDeliveryTiles.delete(key);
  rules.deliveryMultipliers.delete(key);
}

function applyRuleChange(llmState, outcome) {
  refreshPersistentMemory(llmState);
  return `${outcome}\nPersistent memory is now:\n${llmState.persistentMemory}`;
}

// ---------- stack size ----------

export function setStackSize({ mode, count }, bs, llmState) {
  const allowedModes = new Set(["exactly", "at_least", "at_most"]);

  if (!allowedModes.has(mode)) {
    return `Error: mode must be one of exactly, at_least, at_most; received "${mode}".`;
  }

  if (!Number.isInteger(count) || count <= 0) {
    return `Error: count must be a positive integer, received ${count}.`;
  }

  llmState.persistentRules.stackSize = { mode, count };

  return applyRuleChange(
    llmState,
    `Stack-size rule set: deliver only when carrying ${mode.replace("_", " ")} ${count} parcel(s).`
  );
}

export function removeStackSize(params, bs, llmState) {
  if (!llmState.persistentRules.stackSize) {
    return "No stack-size rule was stored.";
  }

  llmState.persistentRules.stackSize = null;

  return applyRuleChange(llmState, "Stack-size rule removed.");
}

// ---------- parcel reward filters ----------

export function setParcelFilter({ minReward, maxReward }, bs, llmState) {
  const hasMin = typeof minReward === "number" && isFinite(minReward);
  const hasMax = typeof maxReward === "number" && isFinite(maxReward);

  if (!hasMin && !hasMax) {
    return "Error: provide at least one of minReward or maxReward as a number.";
  }

  const filters = llmState.persistentRules.parcelFilters;

  if (hasMin) filters.minReward = minReward;
  if (hasMax) filters.maxReward = maxReward;

  return applyRuleChange(
    llmState,
    `Parcel filter updated: minReward=${filters.minReward ?? "none"}, maxReward=${filters.maxReward ?? "none"}.`
  );
}

export function removeParcelFilter(params, bs, llmState) {
  const filters = llmState.persistentRules.parcelFilters;

  if (filters.minReward == null && filters.maxReward == null) {
    return "No parcel reward filter was stored.";
  }

  filters.minReward = null;
  filters.maxReward = null;

  return applyRuleChange(llmState, "Parcel reward filters removed.");
}

// ---------- delivery tile rules ----------

export function forbidDeliveryTile({ x, y }, bs, llmState) {
  const error = validateDeliveryTile(x, y, bs);
  if (error) return error;

  const rules = llmState.persistentRules;
  const key = tileKey(x, y);

  clearDeliveryTileRules(rules, key);
  rules.forbiddenDeliveryTiles.add(key);

  return applyRuleChange(llmState, `Tile (${x}, ${y}) is now a forbidden delivery tile.`);
}

export function preferDeliveryTile({ x, y }, bs, llmState) {
  const error = validateDeliveryTile(x, y, bs);
  if (error) return error;

  const rules = llmState.persistentRules;
  const key = tileKey(x, y);

  clearDeliveryTileRules(rules, key);
  rules.preferredDeliveryTiles.add(key);

  return applyRuleChange(llmState, `Tile (${x}, ${y}) is now a preferred delivery tile.`);
}

export function setDeliveryMultiplier({ x, y, multiplier }, bs, llmState) {
  const error = validateDeliveryTile(x, y, bs);
  if (error) return error;

  if (typeof multiplier !== "number" || !isFinite(multiplier) || multiplier < 0) {
    return `Error: multiplier must be a non-negative number, received ${multiplier}.`;
  }

  const rules = llmState.persistentRules;
  const key = tileKey(x, y);

  clearDeliveryTileRules(rules, key);
  rules.deliveryMultipliers.set(key, multiplier);

  return applyRuleChange(
    llmState,
    `Delivery at tile (${x}, ${y}) now gives ${multiplier}x reward.`
  );
}

export function removeDeliveryTileRule({ x, y }, bs, llmState) {
  const error = validateDeliveryTile(x, y, bs);
  if (error) return error;

  const rules = llmState.persistentRules;
  const key = tileKey(x, y);

  const existed =
    rules.forbiddenDeliveryTiles.has(key) ||
    rules.preferredDeliveryTiles.has(key) ||
    rules.deliveryMultipliers.has(key);

  if (!existed) {
    return `No delivery rule was stored for tile (${x}, ${y}).`;
  }

  clearDeliveryTileRules(rules, key);

  return applyRuleChange(llmState, `Removed delivery rule for tile (${x}, ${y}).`);
}

// ---------- clear all strategy rules ----------

export function clearPersistentRules(params, bs, llmState) {
  const rules = llmState.persistentRules;

  rules.stackSize = null;
  rules.parcelFilters.minReward = null;
  rules.parcelFilters.maxReward = null;
  rules.forbiddenDeliveryTiles.clear();
  rules.preferredDeliveryTiles.clear();
  rules.deliveryMultipliers.clear();

  return applyRuleChange(
    llmState,
    "All persistent strategy rules cleared. Navigation blocks are unchanged: use unblock_tile to remove them."
  );
}

// ==========================================
// block_tile / unblock_tile
// ==========================================

/*
 * Tools for blocking or unblocking a specific tile for pathfinding.
 * Useful for imposing dynamic navigation constraints.
 */

export function blockTile({ x, y }, bs, llmState) {
  if (!isInsideMap(x, y, bs.map)) {
    return `Error: tile (${x}, ${y}) is outside the map.`;
  }

  const key = `${x},${y}`;

  if (llmState.persistentRules.blockedTiles.has(key)) {
    return `Tile (${x}, ${y}) is already blocked for pathfinding.`;
  }

  llmState.persistentRules.blockedTiles.add(key);
  refreshPersistentMemory(llmState);

  return `Tile (${x}, ${y}) is now blocked for pathfinding.`;
}

export function unblockTile({ x, y }, bs, llmState) {
  if (!isInsideMap(x, y, bs.map)) {
    return `Error: tile (${x}, ${y}) is outside the map.`;
  }

  const key = `${x},${y}`;

  if (!llmState.persistentRules.blockedTiles.has(key)) {
    return `Tile (${x}, ${y}) was not blocked.`;
  }

  llmState.persistentRules.blockedTiles.delete(key);
  refreshPersistentMemory(llmState);

  return `Tile (${x}, ${y}) is now walkable again for pathfinding.`;
}