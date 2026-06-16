import { evaluate as mathEvaluate } from "mathjs";
import { distance, isInsideMap, isDeliveryTile } from "../utils/mapUtils.js";
import { nearestDeliveryTileAt, deliveryMapDistance } from "../utils/stateUtils.js";
import { getDecayPerStep } from "../utils/decayModel.js";
import {
  DEFAULT_FORBID_PENALTY,
  DEFAULT_PREFER_REWARD,
  DEFAULT_BLOCK_PENALTY,
} from "../utils/constants.js";
import { stackRulesConflict } from "../bdi/ruleScoring.js";

// ==========================================
// calculate
// ==========================================

/*
 * Evaluates a mathematical expression and returns the result as a string.
 * Used by the mission loop when coordinates are expressed as formulas.
 */
export function calculate({ expression }) {
  try {
    // mathjs evaluates in a sandboxed math scope — no access to JS globals.
    // Supports: +, -, *, /, %, ^, **, sqrt(), abs(), floor(), ceil(), log(),
    // negative numbers, parentheses, and all standard math functions.
    const result = mathEvaluate(expression);

    if (typeof result !== "number" || !isFinite(result)) {
      return `Error: expression did not produce a finite number: ${expression}`;
    }

    return `${expression} = ${result}`;
  } catch (error) {
    return `Error: could not evaluate "${expression}": ${error.message}`;
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
    tile = tiles.reduce((a, b) => (b.y < a.y ? b : a));
  } else if (normalized === "bottommost") {
    tile = tiles.reduce((a, b) => (b.y > a.y ? b : a));
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

export function get_environment_state(bs, llmState, missionStats = null) {
  const me = bs.me;
  const rules = bs.rules ?? {};

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

  const multipliers = rules.deliveryMultipliers ?? new Map();
  const preferred = rules.preferredDeliveries ?? new Map();

  // Reward lost per tile per carried parcel, shared across all delivery-tile
  // estimates. Same event-based decay model the BDI agent uses (decay ticks
  // per move-ack, lag-invariant); 0 when parcels do not decay. This replaces
  // the old wall-clock speed estimate, so both agents now price decay
  // identically.
  const rewardLossPerTile = getDecayPerStep(bs);
  const totalCarriedReward = carriedParcels.reduce((sum, p) => sum + p.reward, 0);
  const numCarried = carriedParcels.length;

  // Delivery tiles are enriched with:
  //   - BFS distance (accurate path length, not Manhattan)
  //   - rewardMultiplier and preferred flags when rules apply
  //   - estimatedNetValue: expected reward after decay and multiplier
  //     (only meaningful when carrying parcels)
  // Tiles are sorted by estimatedNetValue desc when carrying,
  // or by distance asc when not carrying.
  const deliveryTiles = bs.map.deliveryTiles
    .map((tile) => {
      const key = `${tile.x},${tile.y}`;
      const multiplier = multipliers.has(key) ? multipliers.get(key) : 1;

      // BFS distance from current position — falls back to Manhattan if map not ready
      const bfsDistance =
        deliveryMapDistance(bs.map.deliveryDistanceMap, me, tile) ??
        distance(me, tile);

      // Total reward remaining at delivery = (reward * multiplier) - decay during travel
      // Decay = steps × rewardLossPerTile × numCarried (one unit of decay per parcel per tile)
      const estimatedNetValue =
        numCarried > 0
          ? Math.max(0, Math.round(totalCarriedReward * multiplier - bfsDistance * rewardLossPerTile * numCarried))
          : null;

      return {
        x: tile.x,
        y: tile.y,
        distanceToMe: bfsDistance,
        ...(multiplier !== 1 ? { rewardMultiplier: multiplier } : {}),
        ...(preferred.has(key) ? { preferred: true } : {}),
        ...(estimatedNetValue !== null ? { estimatedNetValue } : {}),
      };
    })
    .sort((a, b) => {
      if (numCarried > 0) {
        // Primary: highest estimated net value
        const diff = (b.estimatedNetValue ?? 0) - (a.estimatedNetValue ?? 0);
        if (diff !== 0) return diff;
      }
      // Fallback: nearest tile
      return a.distanceToMe - b.distanceToMe;
    })
    .slice(0, 5);

  const partner =
    bs.partner && bs.partner.id != null && bs.partner.x != null
      ? {
          id: bs.partner.id,
          x: Math.round(bs.partner.x),
          y: Math.round(bs.partner.y),
        }
      : null;

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

    partner,

    coordination: {
      active: !!llmState.coordination?.active,
      partnerParkedOn: llmState.coordination?.partnerParkedOn ?? null,
    },

    ...(missionStats !== null ? { missionDeliveries: missionStats.deliveries } : {}),

    persistentMemory: bs.rules?.rendered ?? "None.",
  });
}

/*
  * Builds a snapshot of the current environment state for the validator prompt.
*/
export function buildValidatorSnapshot(bs, llmState) {
  const carriedParcels = [...bs.parcels.values()]
    .filter((p) => p.carriedBy === bs.me.id)
    .map((p) => ({
      id: p.id,
      reward: p.reward ?? 0,
    }));

  const visibleParcels = [...bs.parcels.values()]
    .filter((p) => !p.carriedBy)
    .map((p) => ({
      id: p.id,
      x: Math.round(p.x),
      y: Math.round(p.y),
      reward: p.reward ?? 0,
    }))
    .slice(0, 8);

  const partner =
    bs.partner && bs.partner.id != null && bs.partner.x != null
      ? {
          id: bs.partner.id,
          x: Math.round(bs.partner.x),
          y: Math.round(bs.partner.y),
        }
      : null;

  return {
    me: {
      x: Math.round(bs.me.x),
      y: Math.round(bs.me.y),
      score: bs.me.score,
    },
    carried: {
      count: carriedParcels.length,
      parcels: carriedParcels,
    },
    visibleParcels,
    deliveryTiles: bs.map.deliveryTiles.map((t) => ({ x: t.x, y: t.y })).slice(0, 8),
    partner,
    coordination: {
      active: !!llmState.coordination?.active,
      partnerParkedOn: llmState.coordination?.partnerParkedOn ?? null,
    },
    persistentRules: bs.rules?.rendered,
  };
}


// ==========================================
// formatPersistentRules
// ==========================================

/*
 * Renders the rule set (the single source of truth, bs.rules) into the
 * human/LLM-readable string stored in bs.rules.rendered.
 */
export function formatPersistentRules(rules) {
  if (!rules) return "None.";

  const lines = [];

  const modeLabels = {
    exactly: "exactly",
    at_least: "at least",
    at_most: "at most",
  };
  const stackRules = Array.isArray(rules.stackSize)
    ? rules.stackSize
    : rules.stackSize
      ? [rules.stackSize]
      : [];

  for (const ss of stackRules) {
    const label = modeLabels[ss.mode] ?? ss.mode;

    const mods = [];
    const penalty = ss.unmet?.delta ?? 0;
    if (penalty < 0) mods.push(`penalty ${-penalty} otherwise`);
    if (ss.unmet?.mult != null && ss.unmet.mult !== 1) {
      mods.push(`${ss.unmet.mult}x reward otherwise`);
    }
    if (ss.met?.delta) mods.push(`reward ${ss.met.delta} when met`);
    if (ss.met?.mult != null && ss.met.mult !== 1) {
      mods.push(`${ss.met.mult}x reward when met`);
    }
    const suffix = mods.length ? ` [${mods.join(", ")}]` : "";

    lines.push(
      `- Prefer delivering when carrying ${label} ${ss.count} parcel(s)${suffix}.`
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

  for (const [key, entry] of rules.penaltyDeliveries ?? []) {
    lines.push(`- Avoid delivering at tile (${key}) [penalty ${entry.penalty}].`);
  }

  for (const [key, entry] of rules.preferredDeliveries ?? []) {
    lines.push(`- Prefer delivering at tile (${key}) [reward ${entry.reward}].`);
  }

  for (const [key, multiplier] of rules.deliveryMultipliers ?? []) {
    lines.push(`- Delivery at tile (${key}) gives ${multiplier}x reward.`);
  }

  for (const [key, entry] of rules.penaltyTiles ?? []) {
    lines.push(`- Navigation: penalize passing through tile (${key}) [penalty ${entry.penalty}].`);
  }

  return lines.length > 0 ? lines.join("\n") : "None.";
}

function refreshRendered(bs) {
  bs.rules.rendered = formatPersistentRules(bs.rules);
  // Single choke point for every rule add/drop: notify any listener (the LLM
  // agent uses this to sync the ruleset to its BDI-only partner).
  bs.rules.onChange?.();
}

// ==========================================
// Persistent rule tools (atomic)
// ==========================================

/*
 * Each tool applies exactly one structured change to
 * bs.rules (the single source of truth),
 * then regenerates the readable rendered string.
 * No LLM call involved: the mission LLM already translated
 * natural language into structured fields via the tool schemas.
 */

function tileKey(x, y) {
  return `${x},${y}`;
}

/*
 * Resolves an LLM-supplied penalty/reward magnitude: falls back to the
 * default when omitted, otherwise requires a non-negative finite number.
 * Returns the numeric magnitude on success, or an error string to surface.
 */
function resolveMagnitude(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "number" || !isFinite(value) || value < 0) {
    return `Error: magnitude must be a non-negative number, received ${value}.`;
  }
  return value;
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
  rules.penaltyDeliveries.delete(key);
  rules.preferredDeliveries.delete(key);
  rules.deliveryMultipliers.delete(key);
}

function applyRuleChange(bs, outcome) {
  refreshRendered(bs);
  return `${outcome}\nPersistent memory is now:\n${bs.rules.rendered}`;
}

// ---------- stack size ----------

export function setStackSize(
  { mode, count, metReward, metMultiplier, unmetPenalty, unmetMultiplier },
  bs
) {
  const allowedModes = new Set(["exactly", "at_least", "at_most"]);

  if (!allowedModes.has(mode)) {
    return `Error: mode must be one of exactly, at_least, at_most; received "${mode}".`;
  }

  if (!Number.isInteger(count) || count <= 0) {
    return `Error: count must be a positive integer, received ${count}.`;
  }

  // Multipliers must be non-negative: a negative one would flip the delivery's
  // sign, which is meaningless. 0 is allowed and meaningful (e.g. "no points off
  // target" => unmetMultiplier 0).
  for (const [v, name] of [
    [metMultiplier, "metMultiplier"],
    [unmetMultiplier, "unmetMultiplier"],
  ]) {
    if (v !== undefined && (typeof v !== "number" || !isFinite(v) || v < 0)) {
      return `Error: ${name} must be a non-negative number, received ${v}.`;
    }
  }

  // Soft delivery-score modifier with two regimes: `met` (carried count on the
  // target) and `unmet` (off it). Each regime takes an optional flat shift and
  // an optional multiplier; defaults are identity. Per-regime names keep the
  // mission from landing an effect on the wrong side — e.g. "0 points under 2"
  // is unmetMultiplier 0, "double for 3+" is metMultiplier 2, "under 3 costs
  // 10" is unmetPenalty 10, "+20 for a full stack" is metReward 20.
  const met = { mult: 1, delta: 0 };
  const unmet = { mult: 1, delta: 0 };

  if (typeof metReward === "number" && isFinite(metReward)) {
    met.delta = metReward;
  }
  if (typeof metMultiplier === "number" && isFinite(metMultiplier)) {
    met.mult = metMultiplier;
  }
  if (typeof unmetPenalty === "number" && isFinite(unmetPenalty)) {
    unmet.delta = -Math.abs(unmetPenalty);
  }
  if (typeof unmetMultiplier === "number" && isFinite(unmetMultiplier)) {
    unmet.mult = unmetMultiplier;
  }

  const newRule = { mode, count, met, unmet };

  if (!Array.isArray(bs.rules.stackSize)) bs.rules.stackSize = [];

  // Several compatible constraints coexist. Overwrite only those the new rule
  // genuinely contradicts (or restates with the same target) — the LLM
  // validator already decided to accept this as an override; here we just clear
  // the now-superseded rules so the active set stays self-consistent.
  const superseded = bs.rules.stackSize.filter(
    (r) =>
      (r.mode === mode && r.count === count) || stackRulesConflict(r, newRule)
  );
  bs.rules.stackSize = bs.rules.stackSize.filter(
    (r) => !superseded.includes(r)
  );
  bs.rules.stackSize.push(newRule);

  const label = `${mode.replace("_", " ")} ${count}`;
  const note =
    superseded.length > 0
      ? ` (replaced ${superseded.length} conflicting rule(s))`
      : ` (now ${bs.rules.stackSize.length} stack rule(s) active)`;

  return applyRuleChange(
    bs,
    `Stack-size rule set: prefer delivering when carrying ${label} parcel(s)${note}.`
  );
}

export function removeStackSize({ mode, count } = {}, bs) {
  const rules = Array.isArray(bs.rules.stackSize) ? bs.rules.stackSize : [];

  if (rules.length === 0) {
    return "No stack-size rule was stored.";
  }

  // With a mode+count, remove just that rule; otherwise clear them all.
  if (mode != null && count != null) {
    const kept = rules.filter((r) => !(r.mode === mode && r.count === count));
    if (kept.length === rules.length) {
      return `No stack-size rule matching "${mode} ${count}" was stored.`;
    }
    bs.rules.stackSize = kept;
    return applyRuleChange(
      bs,
      `Stack-size rule removed: ${mode.replace("_", " ")} ${count}.`
    );
  }

  bs.rules.stackSize = [];
  return applyRuleChange(bs, `All stack-size rules removed (${rules.length}).`);
}

// ---------- parcel reward filters ----------

export function setParcelFilter({ minReward, maxReward }, bs) {
  const hasMin = typeof minReward === "number" && isFinite(minReward);
  const hasMax = typeof maxReward === "number" && isFinite(maxReward);

  if (!hasMin && !hasMax) {
    return "Error: provide at least one of minReward or maxReward as a number.";
  }

  const filters = bs.rules.parcelFilters;

  if (hasMin) filters.minReward = minReward;
  if (hasMax) filters.maxReward = maxReward;

  return applyRuleChange(
    bs,
    `Parcel filter updated: minReward=${filters.minReward ?? "none"}, maxReward=${filters.maxReward ?? "none"}.`
  );
}

export function removeParcelFilter(params, bs) {
  const filters = bs.rules.parcelFilters;

  if (filters.minReward == null && filters.maxReward == null) {
    return "No parcel reward filter was stored.";
  }

  filters.minReward = null;
  filters.maxReward = null;

  return applyRuleChange(bs, "Parcel reward filters removed.");
}

// ---------- delivery tile rules ----------

export function forbidDeliveryTile({ x, y, penalty }, bs) {
  const error = validateDeliveryTile(x, y, bs);
  if (error) return error;

  const magnitude = resolveMagnitude(penalty, DEFAULT_FORBID_PENALTY);
  if (typeof magnitude === "string") return magnitude;

  const rules = bs.rules;
  const key = tileKey(x, y);

  clearDeliveryTileRules(rules, key);
  rules.penaltyDeliveries.set(key, { x, y, penalty: magnitude });

  return applyRuleChange(
    bs,
    `Tile (${x}, ${y}) is now a penalized delivery tile (penalty ${magnitude}).`
  );
}

export function preferDeliveryTile({ x, y, reward }, bs) {
  const error = validateDeliveryTile(x, y, bs);
  if (error) return error;

  const magnitude = resolveMagnitude(reward, DEFAULT_PREFER_REWARD);
  if (typeof magnitude === "string") return magnitude;

  const rules = bs.rules;
  const key = tileKey(x, y);

  clearDeliveryTileRules(rules, key);
  rules.preferredDeliveries.set(key, { x, y, reward: magnitude });

  return applyRuleChange(
    bs,
    `Tile (${x}, ${y}) is now a preferred delivery tile (reward ${magnitude}).`
  );
}

export function setDeliveryMultiplier({ x, y, multiplier }, bs) {
  const error = validateDeliveryTile(x, y, bs);
  if (error) return error;

  if (typeof multiplier !== "number" || !isFinite(multiplier) || multiplier < 0) {
    return `Error: multiplier must be a non-negative number, received ${multiplier}.`;
  }

  const rules = bs.rules;
  const key = tileKey(x, y);

  clearDeliveryTileRules(rules, key);
  rules.deliveryMultipliers.set(key, multiplier);

  return applyRuleChange(
    bs,
    `Delivery at tile (${x}, ${y}) now gives ${multiplier}x reward.`
  );
}

export function removeDeliveryTileRule({ x, y }, bs) {
  const error = validateDeliveryTile(x, y, bs);
  if (error) return error;

  const rules = bs.rules;
  const key = tileKey(x, y);

  const existed =
    rules.penaltyDeliveries.has(key) ||
    rules.preferredDeliveries.has(key) ||
    rules.deliveryMultipliers.has(key);

  if (!existed) {
    return `No delivery rule was stored for tile (${x}, ${y}).`;
  }

  clearDeliveryTileRules(rules, key);

  return applyRuleChange(bs, `Removed delivery rule for tile (${x}, ${y}).`);
}

// ---------- clear all strategy rules ----------

export function clearPersistentRules(params, bs) {
  const rules = bs.rules;

  rules.stackSize = [];
  rules.parcelFilters.minReward = null;
  rules.parcelFilters.maxReward = null;
  rules.penaltyDeliveries.clear();
  rules.preferredDeliveries.clear();
  rules.deliveryMultipliers.clear();

  return applyRuleChange(
    bs,
    "All persistent strategy rules cleared. Navigation penalties are unchanged: use unblock_tile to remove them."
  );
}

// ==========================================
// block_tile / unblock_tile
// ==========================================

/*
 * Tools for blocking or unblocking a specific tile for pathfinding.
 * Useful for imposing dynamic navigation constraints.
 */

export function blockTile({ x, y, penalty }, bs) {
  if (!isInsideMap(x, y, bs.map)) {
    return `Error: tile (${x}, ${y}) is outside the map.`;
  }

  const magnitude = resolveMagnitude(penalty, DEFAULT_BLOCK_PENALTY);
  if (typeof magnitude === "string") return magnitude;

  const key = `${x},${y}`;

  if (bs.rules.penaltyTiles.has(key)) {
    return `Tile (${x}, ${y}) is already penalized for pathfinding.`;
  }

  bs.rules.penaltyTiles.set(key, { x, y, penalty: magnitude });
  refreshRendered(bs);

  return `Tile (${x}, ${y}) is now penalized for pathfinding (penalty ${magnitude}).`;
}

export function unblockTile({ x, y }, bs) {
  if (!isInsideMap(x, y, bs.map)) {
    return `Error: tile (${x}, ${y}) is outside the map.`;
  }

  const key = `${x},${y}`;

  if (!bs.rules.penaltyTiles.has(key)) {
    return `Tile (${x}, ${y}) was not penalized.`;
  }

  bs.rules.penaltyTiles.delete(key);
  refreshRendered(bs);

  return `Tile (${x}, ${y}) is now walkable again for pathfinding.`;
}