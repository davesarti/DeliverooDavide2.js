/*
 * Persistent-rule effects on autonomous BDI scoring.
 *
 * These feed the autonomous option/score loop. Two flavours, matching intent:
 *
 *  - parcelFilters is a *gate* (an exclusion rule): a parcel outside the reward
 *    band is never a pickup candidate.
 *  - stackSize and the delivery-tile rules are *preferences*: they shift a
 *    delivery's (or pickup's) score so the favoured option wins, but never make
 *    a delivery impossible. stackSize is therefore soft — it penalises/rewards
 *    delivering at a given stack value instead of forbidding it, so a plain
 *    "deliver this" mission is never blocked.
 *
 * Everything stays strand-safe: a preference can lower an option's score but
 * the delivery floor (see adjustDeliveryScore) means it never removes the
 * agent's only way to bank — the "a rule can never strand the agent" invariant.
 */

const IDENTITY = { mult: 1, delta: 0 };

/*
 * Pickup gate from the persistent reward filter. True when the parcel's reward
 * is within [minReward, maxReward]; null bounds are open. Mirrors
 * validateParcelReward so the autonomous path excludes exactly the parcels the
 * directive path rejects.
 */
export function passesParcelFilter(parcel, rules) {
  const reward = parcel?.reward ?? 0;
  const minReward = rules?.parcelFilters?.minReward;
  const maxReward = rules?.parcelFilters?.maxReward;

  if (minReward != null && reward < minReward) return false;
  if (maxReward != null && reward > maxReward) return false;

  return true;
}

/*
 * stackSize holds MANY rules (an array). Several compatible constraints can be
 * active at once — e.g. "at_least 2" and "at_most 5" — and their modifiers
 * combine. Conflict resolution (which rule survives when two contradict) is not
 * done here: the LLM validator decides accept(=overwrite)/reject(=keep old) and
 * setStackSize drops the genuinely-conflicting old rules via stackRulesConflict.
 */

/*
 * Normalises rules.stackSize into an array of valid rules. Tolerates a legacy
 * single-object value and null/undefined so older snapshots never crash.
 */
function stackRulesOf(rules) {
  const ss = rules?.stackSize;
  if (Array.isArray(ss)) return ss.filter(isValidStackRule);
  if (isValidStackRule(ss)) return [ss];
  return [];
}

function isValidStackRule(r) {
  return (
    !!r &&
    Number.isInteger(r.count) &&
    r.count > 0 &&
    (r.mode === "exactly" || r.mode === "at_least" || r.mode === "at_most")
  );
}

function stackRuleSatisfied(rule, carriedCount) {
  if (rule.mode === "at_least") return carriedCount >= rule.count;
  if (rule.mode === "exactly") return carriedCount === rule.count;
  if (rule.mode === "at_most") return carriedCount <= rule.count;
  return true;
}

/*
 * The inclusive carried-count range in which a rule's stack is "met".
 * at_least N -> [N, ∞); at_most N -> [1, N]; exactly N -> [N, N].
 */
function stackRange(rule) {
  if (rule.mode === "at_least") return [rule.count, Infinity];
  if (rule.mode === "at_most") return [1, rule.count];
  return [rule.count, rule.count];
}

/*
 * Two stack rules conflict when no single carried count can satisfy both —
 * i.e. their met-ranges do not overlap. "exactly 3" vs "exactly 5", "at_least
 * 4" vs "at_most 2", and "exactly 3" vs "at_least 4" conflict; "at_least 2" vs
 * "at_most 5" and "at_least 3" vs "exactly 3" do not.
 */
export function stackRulesConflict(a, b) {
  if (!isValidStackRule(a) || !isValidStackRule(b)) return false;
  const [aLo, aHi] = stackRange(a);
  const [bLo, bHi] = stackRange(b);
  return Math.max(aLo, bLo) > Math.min(aHi, bHi);
}

/*
 * Combines several { mult, delta } modifiers into one: multiply the multipliers,
 * sum the deltas. Empty -> identity.
 */
function combine(modifiers) {
  let mult = 1;
  let delta = 0;
  for (const m of modifiers) {
    mult *= m?.mult ?? 1;
    delta += m?.delta ?? 0;
  }
  return { mult, delta };
}

/*
 * Applies a { mult, delta } stack modifier to a delivered value:
 *   adjusted = value * mult + delta
 * Missing fields default to identity.
 */
export function applyStackModifier(value, modifier) {
  return value * (modifier?.mult ?? 1) + (modifier?.delta ?? 0);
}

/*
 * Combined stack modifier governing the DELIVERY action at the actual carried
 * count: each active rule contributes its `met` modifier when its own stack is
 * satisfied, `unmet` otherwise. Identity when no rules are active.
 */
export function stackDeliveryModifier(carriedCount, rules) {
  return combine(
    stackRulesOf(rules).map((r) =>
      stackRuleSatisfied(r, carriedCount) ? r.met ?? IDENTITY : r.unmet ?? IDENTITY
    )
  );
}

/*
 * Combined stack modifier for valuing a PICKUP that would leave the agent
 * carrying `resultingCount` parcels (approach b — no hard cap). Per rule:
 * pickups toward its target are valued optimistically with `met` (the agent
 * commits to completing the stack, so a gather step is never punished by an
 * under-stack penalty it intends to avoid); only a pickup that OVERSHOOTS an
 * exactly/at_most cap takes that rule's `unmet` modifier, pricing in the lost
 * bonus so an exceptionally rich parcel can still justify breaking the stack.
 */
export function stackPickupModifier(resultingCount, rules) {
  return combine(
    stackRulesOf(rules).map((r) => {
      const overshoot =
        (r.mode === "exactly" || r.mode === "at_most") &&
        resultingCount > r.count;
      return overshoot ? r.unmet ?? IDENTITY : r.met ?? IDENTITY;
    })
  );
}

/*
 * Combined modifier the agent would earn once every active rule's target stack
 * is met (all `met` sides). Used to value how much continuing to camp toward
 * the targets is worth. Identity when no rules are active.
 */
export function stackMetModifier(rules) {
  return combine(stackRulesOf(rules).map((r) => r.met ?? IDENTITY));
}

/*
 * Soft delivery-target preference for the tile (x, y). Applies the multiplier
 * to the base value, then the additive preferred-reward and penalty:
 *
 *   adjusted = base * multiplier + preferredReward - penalty
 *
 * Defaults are identity (multiplier 1, reward/penalty 0), so a tile with no
 * rules scores unchanged. These never gate — they only reorder which delivery
 * tile the agent heads for.
 *
 * The result is floored at 0: a delivery's base value is already >= 0, and
 * sortQueueByScore keeps a carried-parcel delivery only while its score stays
 * >= 0. Letting a penalty drive it negative would drop the agent's only way to
 * bank and strand it carrying. Flooring keeps penalties as pure reordering —
 * a penalised tile loses to any cheaper delivery but never to "never deliver".
 */
export function adjustDeliveryScore(base, rules, x, y) {
  const key = `${x},${y}`;
  const multiplier = rules?.deliveryMultipliers?.get(key) ?? 1;
  const reward = rules?.preferredDeliveries?.get(key)?.reward ?? 0;
  const penalty = rules?.penaltyDeliveries?.get(key)?.penalty ?? 0;

  return Math.max(0, base * multiplier + reward - penalty);
}
