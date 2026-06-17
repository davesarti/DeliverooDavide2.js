/*
 * Persistent-rule effects on autonomous BDI scoring.
 *
 * These feed the autonomous option/score loop. Two flavours, matching intent:
 *
 *  - parcelValueRules is an array of value-band remaps: the delivered value of a
 *    parcel is multiplied/shifted by matching rules at scoring time.
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
 * Parcel value rules (an array of value-band remaps). A rule is
 * { minReward, maxReward, mult, delta } with null bounds open and bounds
 * inclusive. A parcel's delivered value `v` is "in band" when it lies in
 * [minReward, maxReward]; every in-band rule contributes its { mult, delta }
 * (mults multiply, deltas sum, mirroring combineStack), so the delivered value
 * banks `v * mult + delta` instead of `v`. Out-of-band rules contribute the
 * identity, so a parcel no rule covers banks `v` unchanged.
 *
 * No floor is applied: setParcelValueRule validates mult >= 0 and delta >= 0,
 * so an in-band remap of a non-negative delivered value stays non-negative, and
 * with no matching rule the value passes through untouched. This keeps the
 * existing no-rule scoring arithmetic in intentionScore byte-for-byte identical.
 */
function valueRulesOf(rules) {
  const vr = rules?.parcelValueRules;
  return Array.isArray(vr) ? vr.filter(isValidValueRule) : [];
}

export function isValidValueRule(r) {
  if (!r) return false;
  const numOrNull = (v) =>
    v == null || (typeof v === "number" && Number.isFinite(v));
  const hasBound = r.minReward != null || r.maxReward != null;
  const multOk =
    r.mult == null ||
    (typeof r.mult === "number" && Number.isFinite(r.mult) && r.mult >= 0);
  const deltaOk =
    r.delta == null ||
    (typeof r.delta === "number" && Number.isFinite(r.delta) && r.delta >= 0);
  return numOrNull(r.minReward) && numOrNull(r.maxReward) && hasBound && multOk && deltaOk;
}

function valueInBand(value, rule) {
  if (rule.minReward != null && value < rule.minReward) return false;
  if (rule.maxReward != null && value > rule.maxReward) return false;
  return true;
}

export function applyParcelValueBand(value, rules) {
  let mult = 1;
  let delta = 0;
  for (const rule of valueRulesOf(rules)) {
    if (valueInBand(value, rule)) {
      mult *= rule.mult ?? 1;
      delta += rule.delta ?? 0;
    }
  }
  return value * mult + delta;
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
 * True when carrying `resultingCount` after a pickup would overshoot an
 * exactly/at_most cap on any active stack rule. Mirrors the overshoot test in
 * stackPickupModifier, but as a plain predicate: opportunistic (zero-detour)
 * pickup uses it to decline a free parcel that would break the stack the rule
 * asks the agent to keep.
 */
export function stackPickupOvershoots(resultingCount, rules) {
  return stackRulesOf(rules).some(
    (r) =>
      (r.mode === "exactly" || r.mode === "at_most") &&
      resultingCount > r.count
  );
}

/*
 * True when `carriedCount` satisfies EVERY active stack rule. Opportunistic
 * dropoff uses it to avoid banking an incomplete stack (e.g. delivering 1 while
 * an "exactly 3" rule is active), which would forfeit the stack bonus the scored
 * loop is gathering toward. No rules -> trivially true.
 */
export function allStackRulesSatisfied(carriedCount, rules) {
  return stackRulesOf(rules).every((r) => stackRuleSatisfied(r, carriedCount));
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
 * Combines every active stack rule into one { mult, delta } modifier: `pick`
 * chooses the modifier each rule contributes (its met or unmet side, depending
 * on context), then the multipliers multiply and the deltas sum. No rules ->
 * identity.
 */
function combineStack(rules, pick) {
  let mult = 1;
  let delta = 0;
  for (const rule of stackRulesOf(rules)) {
    const m = pick(rule) ?? IDENTITY;
    mult *= m.mult ?? 1;
    delta += m.delta ?? 0;
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
  return combineStack(rules, (r) =>
    stackRuleSatisfied(r, carriedCount) ? r.met : r.unmet
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
  return combineStack(rules, (r) => {
    const overshoot =
      (r.mode === "exactly" || r.mode === "at_most") &&
      resultingCount > r.count;
    return overshoot ? r.unmet : r.met;
  });
}

/*
 * How much extra delivery value the agent could still unlock by CAMPING from
 * the current carried count, applied to `value` (its carried reward). Camping
 * only ever ADDS parcels, so this looks solely at higher counts (>= current,
 * up to `maxCount`): the best delivery modifier reachable by gathering more,
 * minus the modifier now. It is the budget by which "wait for spawns" may
 * exceed the base decay budget.
 *
 * Crucially this is 0 when no higher count improves things — e.g. an `at_most`
 * cap that is already exceeded, which camping can never undo (you can't shed
 * parcels by waiting). Using a global "all met" value here instead would
 * wrongly tell the agent to loiter toward an unreachable state.
 *
 * The delivery modifier is piecewise-constant in the count, changing only at
 * rule thresholds, so only those thresholds above the current count need to be
 * probed for the maximum.
 */
export function stackCampGain(carriedCount, value, rules, maxCount = Infinity) {
  const ruleList = stackRulesOf(rules);
  if (ruleList.length === 0) return 0;

  const now = applyStackModifier(value, stackDeliveryModifier(carriedCount, rules));

  let best = now;
  const probes = new Set();
  for (const r of ruleList) {
    if (r.count > carriedCount && r.count <= maxCount) probes.add(r.count);
  }
  for (const c of probes) {
    best = Math.max(
      best,
      applyStackModifier(value, stackDeliveryModifier(c, rules))
    );
  }

  return Math.max(0, best - now);
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
