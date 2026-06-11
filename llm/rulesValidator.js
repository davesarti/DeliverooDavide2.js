import {
  isInsideMap,
  isBlockedTile,
  isDeliveryTile
} from "../utils/mapUtils.js";

/*
 * Returns:
 * - null if the action is allowed
 * - a string error message if the action must be rejected
 */
export function validateActionAgainstPersistentRules(action, bs, llmState) {
  if (!action || !action.name) {
    return "invalid action: missing action name";
  }

  const rules = llmState?.persistentRules;

  if (!rules) {
    return null;
  }

  const params = action.params ?? {};

  switch (action.name) {
    case "go_to":
      return validateGoTo(params, bs, rules);

    case "go_pick_up":
      return validateGoPickUp(params, bs, rules);

    case "go_drop_off":
      return validateGoDropOff(params, bs, rules);

    case "explore":
      return validateExplore(rules);

    default:
      return null;
  }
}

// ==========================================
// go_to
// ==========================================

function validateGoTo(params, bs, rules) {
  const coordError = validateCoordinates(params.x, params.y, bs, "target");
  if (coordError) return coordError;

  if (isBlockedTile(params.x, params.y, rules.blockedTiles)) {
    return `target tile (${params.x}, ${params.y}) is blocked by persistent rules`;
  }

  return null;
}

// ==========================================
// go_pick_up
// ==========================================

function validateGoPickUp(params, bs, rules) {
  const coordError = validateCoordinates(params.x, params.y, bs, "pickup");
  if (coordError) return coordError;

  if (!params.parcelId) {
    return "pickup rejected: missing parcel id";
  }

  if (isBlockedTile(params.x, params.y, rules.blockedTiles)) {
    return `pickup rejected: tile (${params.x}, ${params.y}) is blocked by persistent rules`;
  }

  const parcel = bs.parcels?.get(params.parcelId);

  if (!parcel) {
    return `pickup rejected: parcel ${params.parcelId} is not visible or no longer exists`;
  }

  const parcelX = Math.round(parcel.x);
  const parcelY = Math.round(parcel.y);

  if (parcelX !== params.x || parcelY !== params.y) {
    return `pickup rejected: parcel ${params.parcelId} is at (${parcelX}, ${parcelY}), not at (${params.x}, ${params.y})`;
  }

  if (parcel.carriedBy) {
    return `pickup rejected: parcel ${params.parcelId} is already carried by ${parcel.carriedBy}`;
  }

  const rewardError = validateParcelReward(parcel, rules, "pickup");
  if (rewardError) return rewardError;

  return null;
}

// ==========================================
// go_drop_off
// ==========================================

function validateGoDropOff(params, bs, rules) {
  const coordError = validateCoordinates(params.x, params.y, bs, "delivery");
  if (coordError) return coordError;

  if (isBlockedTile(params.x, params.y, rules.blockedTiles)) {
    return `delivery rejected: tile (${params.x}, ${params.y}) is blocked by persistent rules`;
  }

  if (!isDeliveryTile(params.x, params.y, bs.map.deliveryTiles)) {
    return `delivery rejected: tile (${params.x}, ${params.y}) is not a delivery tile`;
  }

  if (isForbiddenDeliveryTile(params.x, params.y, rules)) {
    return `delivery rejected: delivery tile (${params.x}, ${params.y}) is forbidden by persistent rules`;
  }

  const carriedParcels = getCarriedParcels(bs);
  const carriedCount = carriedParcels.length;

  if (carriedCount === 0) {
    return "delivery rejected: no carried parcels to deliver";
  }

  const stackError = validateStackSize(carriedCount, rules);
  if (stackError) return stackError;

  for (const parcel of carriedParcels) {
    const rewardError = validateParcelReward(parcel, rules, "delivery");
    if (rewardError) return rewardError;
  }

  return null;
}

// ==========================================
// explore
// ==========================================

function validateExplore(rules) {
  /*
   * Exploration is normally allowed.
   * The actual movement path must be handled by pathfinding using rules.blockedTiles.
   */
  return null;
}

// ==========================================
// Shared validators
// ==========================================

function validateCoordinates(x, y, bs, label) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    return `${label} rejected: coordinates must be integers, received (${x}, ${y})`;
  }

  if (!bs?.map) {
    return `${label} rejected: map is not available`;
  }

  if (!isInsideMap(x, y, bs.map)) {
    return `${label} rejected: tile (${x}, ${y}) is outside the map`;
  }

  return null;
}

function validateParcelReward(parcel, rules, actionLabel) {
  const reward = parcel.reward ?? 0;
  const parcelId = parcel.id ?? "unknown";

  const minReward = rules.parcelFilters?.minReward;
  const maxReward = rules.parcelFilters?.maxReward;

  if (minReward != null && reward < minReward) {
    return `${actionLabel} rejected: parcel ${parcelId} has reward ${reward}, below minimum allowed reward ${minReward}`;
  }

  if (maxReward != null && reward > maxReward) {
    return `${actionLabel} rejected: parcel ${parcelId} has reward ${reward}, above maximum allowed reward ${maxReward}`;
  }

  return null;
}

function validateStackSize(carriedCount, rules) {
  const stackSize = rules.stackSize;

  if (!stackSize) return null;

  const mode = stackSize.mode;
  const count = stackSize.count;

  const allowedModes = new Set(["exactly", "at_least", "at_most"]);

  if (!allowedModes.has(mode)) {
    return `delivery rejected: invalid persistent stack-size mode "${mode}"`;
  }

  if (!Number.isInteger(count) || count <= 0) {
    return `delivery rejected: invalid persistent stack-size rule ${JSON.stringify(stackSize)}`;
  }

  if (mode === "exactly" && carriedCount !== count) {
    return `delivery rejected: carrying ${carriedCount} parcel(s), but persistent rules require exactly ${count}`;
  }

  if (mode === "at_least" && carriedCount < count) {
    return `delivery rejected: carrying ${carriedCount} parcel(s), but persistent rules require at least ${count}`;
  }

  if (mode === "at_most" && carriedCount > count) {
    return `delivery rejected: carrying ${carriedCount} parcel(s), but persistent rules allow at most ${count}`;
  }

  return null;
}

// ==========================================
// State helpers
// ==========================================

function getCarriedParcels(bs) {
  if (!bs?.parcels || !bs?.me?.id) return [];

  return [...bs.parcels.values()].filter(
    (parcel) => parcel.carriedBy === bs.me.id
  );
}

function isForbiddenDeliveryTile(x, y, rules) {
  return hasTile(rules.forbiddenDeliveryTiles, x, y);
}

function hasTile(collection, x, y) {
  if (!collection) return false;

  const key = `${x},${y}`;
  const spacedKey = `${x}, ${y}`;

  if (collection instanceof Set) {
    return collection.has(key) || collection.has(spacedKey);
  }

  if (collection instanceof Map) {
    return collection.has(key) || collection.has(spacedKey);
  }

  if (Array.isArray(collection)) {
    return collection.some((item) => {
      if (typeof item === "string") {
        return item === key || item === spacedKey;
      }

      return item?.x === x && item?.y === y;
    });
  }

  return false;
}