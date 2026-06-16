import {
  isInsideMap,
  isDeliveryTile
} from "../utils/mapUtils.js";

/*
 * Returns:
 * - null if the action is allowed
 * - a string error message if the action must be rejected
 */
export function validateActionAgainstPersistentRules(action, bs) {
  if (!action || !action.name) {
    return "invalid action: missing action name";
  }

  const rules = bs?.rules;

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

  return null;
}

// ==========================================
// go_drop_off
// ==========================================

function validateGoDropOff(params, bs, rules) {
  const coordError = validateCoordinates(params.x, params.y, bs, "delivery");
  if (coordError) return coordError;

  if (!isDeliveryTile(params.x, params.y, bs.map.deliveryTiles)) {
    return `delivery rejected: tile (${params.x}, ${params.y}) is not a delivery tile`;
  }

  const carriedParcels = getCarriedParcels(bs);
  const carriedCount = carriedParcels.length;

  if (carriedCount === 0) {
    return "delivery rejected: no carried parcels to deliver";
  }

  // stackSize is a soft preference, not a hard constraint: it penalises or
  // rewards delivering at a given stack value in the autonomous scorer, but it
  // must never reject an explicit "deliver" action — otherwise a mission to
  // deliver a single parcel is refused just because a stack rule prefers more.
  return null;
}

// ==========================================
// explore
// ==========================================

function validateExplore(rules) {
  /*
   * Exploration is normally allowed.
   * The actual movement path must be handled by pathfinding using rules.penaltyTiles.
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

// ==========================================
// State helpers
// ==========================================

function getCarriedParcels(bs) {
  if (!bs?.parcels || !bs?.me?.id) return [];

  return [...bs.parcels.values()].filter(
    (parcel) => parcel.carriedBy === bs.me.id
  );
}

