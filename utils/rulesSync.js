/*
 * Serialization for the LLM ruleset (bs.rules) so it can travel over the
 * coordination `say` channel to the BDI-only partner. The tile collections are
 * Maps, so they are flattened to [key, value] entry arrays for the wire and
 * rebuilt into Maps on receipt. serializeRules and applyRulesSnapshot are
 * inverses — keep them in sync if the rules shape changes.
 */

/*
 * Flattens bs.rules into a plain object safe to send over the wire. `rendered`
 * is included so the receiver does not need the LLM-side formatter.
 */
export function serializeRules(rules) {
  return {
    stackSize: rules.stackSize,
    parcelFilters: {
      minReward: rules.parcelFilters?.minReward ?? null,
      maxReward: rules.parcelFilters?.maxReward ?? null,
    },
    penaltyDeliveries: [...rules.penaltyDeliveries],
    preferredDeliveries: [...rules.preferredDeliveries],
    deliveryMultipliers: [...rules.deliveryMultipliers],
    penaltyTiles: [...rules.penaltyTiles],
    rendered: rules.rendered ?? "None.",
  };
}

/*
 * Applies a received snapshot into an existing rules section in place. The tile
 * Maps are replaced wholesale (consumers read them live each tick, so swapping
 * the reference is safe). `onChange` is intentionally left untouched.
 */
export function applyRulesSnapshot(target, snapshot) {
  if (!target || !snapshot) return;

  target.stackSize = snapshot.stackSize ?? null;
  target.parcelFilters.minReward = snapshot.parcelFilters?.minReward ?? null;
  target.parcelFilters.maxReward = snapshot.parcelFilters?.maxReward ?? null;
  target.penaltyDeliveries = new Map(snapshot.penaltyDeliveries ?? []);
  target.preferredDeliveries = new Map(snapshot.preferredDeliveries ?? []);
  target.deliveryMultipliers = new Map(snapshot.deliveryMultipliers ?? []);
  target.penaltyTiles = new Map(snapshot.penaltyTiles ?? []);
  target.rendered = snapshot.rendered ?? "None.";
}
