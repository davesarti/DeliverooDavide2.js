import { nearestDeliveryTileAt, spawnMapDistance } from "../utils/stateUtils.js";
import { distance } from "../utils/mapUtils.js";
import { getDecayPerStep } from "../utils/decayModel.js";
import {
  RACE_DISCOUNT_TAU,
  HOARD_CAP,
  CAMP_PATIENCE_BASE_MS,
  CAMP_PATIENCE_GROWTH,
  CAMP_PATIENCE_MIN_TILES,
  CAMP_PATIENCE_SATURATION_TILES,
  CAMP_ADJACENCY_RADIUS,
  CAMP_PATIENCE_MIN_MS,
  CAMP_PATIENCE_MAX_MS,
} from "../utils/constants.js";
import { AGENT_CONFIG } from "../config.js";
import { passesParcelFilter } from "./ruleScoring.js";

/*
 * Number of spawn ("green") tiles clustered within CAMP_ADJACENCY_RADIUS of a
 * pocket — the richer the cluster, the more parcels appear there.
 */
function countAdjacentSpawnTiles(bs, anchor) {
  let count = 0;
  for (const tile of bs.map.spawnTiles ?? []) {
    if (
      Math.abs(tile.x - anchor.x) + Math.abs(tile.y - anchor.y) <=
      CAMP_ADJACENCY_RADIUS
    ) {
      count++;
    }
  }
  return count;
}

/*
 * How long camping a pocket is worth waiting at.
 *
 * Driven purely by spatial spawn-cluster density. Below CAMP_PATIENCE_MIN_TILES
 * adjacent green tiles the pocket is too sparse to camp (patience 0); from there
 * the curve climbs exponentially per extra clustered spawn tile and saturates at
 * CAMP_PATIENCE_SATURATION_TILES, where it reaches the MAX cap. The spawn rate is
 * not used as the base, only as a yes/no gate: returns 0 ("never camp") when the
 * server generates no new parcels.
 */
export function campPatienceMs(bs, anchor) {
  if (bs.config.parcelGenerationEvent === "infinite") return 0; // no respawns

  const adjacent = countAdjacentSpawnTiles(bs, anchor);
  if (adjacent < CAMP_PATIENCE_MIN_TILES) return 0; // too sparse to camp

  const n = Math.min(adjacent, CAMP_PATIENCE_SATURATION_TILES);
  const patience =
    CAMP_PATIENCE_BASE_MS *
    (Math.pow(CAMP_PATIENCE_GROWTH, n - (CAMP_PATIENCE_MIN_TILES - 1)) - 1);

  return Math.min(CAMP_PATIENCE_MAX_MS, Math.max(CAMP_PATIENCE_MIN_MS, patience));
}

export const EXPLORATION_INCENTIVE = 0.01;
// Slightly above exploration: a tiny baseline so any real pickup/delivery
// still preempts camping, but camping outranks plain exploration when idle.
export const CAMP_INCENTIVE = 0.02;
export const DROP_DISINCENTIVE = 0;

/*
 * Reward lost per tile traveled, per carried parcel.
 * Estimated purely from server events (decay ticks per move-ack, see
 * utils/decayModel.js): no wall clock is involved, so scoring behaves
 * identically on a laggy server, a fast local one, or under load.
 * 0 when parcels do not decay.
 */
export function distanceFactor(bs) {
  return getDecayPerStep(bs);
}

/*
 * Max parcels worth carrying: the server-declared capacity, additionally
 * capped by HOARD_CAP so the agent always banks eventually even when the
 * server declares no capacity and parcels do not decay (without a cap,
 * "one more pickup" would beat delivery forever in that regime).
 */
export function effectiveCapacity(bs) {
  const declared = Number(bs.config.playerCapacity);
  const capacity =
    Number.isFinite(declared) && declared > 0 ? declared : Infinity;
  // Stack-size no longer hard-caps carrying: over-gathering past an
  // exactly/at_most target is discouraged softly in pickup scoring
  // (stackPickupModifier), so a rich enough parcel can still justify it.
  return Math.min(capacity, HOARD_CAP);
}

/*
 * Distance of the me -> parcel leg only.
 */
export function pickupLegDistance(parcel, me, bs) {
  return (
    spawnMapDistance(
      bs.map.spawnDistanceMap,
      { x: me.x, y: me.y },
      { x: parcel.x, y: parcel.y }
    ) ?? distance({ x: parcel.x, y: parcel.y }, { x: me.x, y: me.y })
  );
}

/*
 * Estimates the cost of picking up a parcel and carrying it to the nearest delivery.
 */
export function pickupRouteDistance(parcel, me, bs) {
  const nearest = nearestDeliveryTileAt(
    { x: parcel.x, y: parcel.y },
    bs.map.deliveryDistanceMap
  );
  if (!nearest) return null;

  return pickupLegDistance(parcel, me, bs) + nearest.distance;
}

/*
 * Probability of winning the race to a parcel against the closest known
 * opponent (from the short-TTL agent memory). Sigmoid on the distance gap:
 * ~1 when we are clearly closer, 0.5 on a tie, ~0 when an opponent is
 * clearly closer — racing for a parcel we statistically never get just
 * wastes travel.
 */
export function raceWinProbability(parcel, me, bs) {
  let opponentDist = Infinity;
  for (const agent of bs.agents.values()) {
    const d = distance(agent, parcel);
    if (d < opponentDist) opponentDist = d;
  }
  if (!Number.isFinite(opponentDist)) return 1;

  const myDist = pickupLegDistance(parcel, me, bs);
  if (myDist == null) return 1;

  return 1 / (1 + Math.exp((myDist - opponentDist) / RACE_DISCOUNT_TAU));
}

/*
 * Expected value of a parcel once competition is considered: the raw reward
 * discounted only by the chance of winning the race to it. We deliberately do
 * NOT add a zone-crowding (agent-presence) penalty: raceWinProbability already
 * accounts for closer opponents per parcel, and it is relative — among parcels
 * we can still win it keeps the best one. An absolute presence penalty, by
 * contrast, multiplies against the fixed exploration floor in intentionScore
 * and can push a winnable parcel below it, making the agent walk away from a
 * pickup it would have gotten.
 */
export function competitionAdjustedReward(parcel, me, bs) {
  return parcel.reward * raceWinProbability(parcel, me, bs);
}

/*
 * Generates the pickup candidates for the current state. This only decides
 * what is *reachable and worth scoring* — the actual value (competition
 * discount, carried-parcel detour cost, decay) lives in intentionScore, which
 * is the single authority on a pickup's worth. Generating bare candidates here
 * avoids a second, divergent value formula that could admit a pickup scoring
 * rejects (or vice versa).
 */
function generatePickupOptions(parcels, me, bs) {
  const deliveryDistanceMap = bs.map.deliveryDistanceMap;
  if (!Array.isArray(deliveryDistanceMap) || deliveryDistanceMap.length === 0) return null;

  // A full agent has nothing to gain from pickups: skip generating them.
  // (This matches the capacity trigger in intentionScore exactly, so it never
  // diverges from scoring — it is only a cheap short-circuit.)
  if ((bs.carry?.count ?? 0) >= effectiveCapacity(bs)) return [];

  const pickupOptions = [];

  for (const parcel of parcels.values()) {
    if (parcel.carriedBy) continue;
    // Persistent reward filter: a parcel outside the band is never a candidate.
    // Cheap short-circuit matching the same gate in intentionScore exactly.
    if (!passesParcelFilter(parcel, bs.rules)) continue;
    if (pickupRouteDistance(parcel, me, bs) == null) continue;
    pickupOptions.push(["go_pick_up", parcel.x, parcel.y, parcel.id]);
  }

  return pickupOptions;
}

/*
 * Generates the available deliveries for already carried parcels.
 */
function generateDeliveryOptions(parcels, me, bs) {
  const deliveryDistanceMap = bs.map.deliveryDistanceMap;
  if (!Array.isArray(deliveryDistanceMap) || deliveryDistanceMap.length === 0) return [];

  if ((bs.carry?.count ?? 0) === 0) return [];

  const row = deliveryDistanceMap[Math.round(me.y)];
  const entries = row?.[Math.round(me.x)];
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const options = [];
  const seen = new Set();

  for (const entry of entries) {
    if (!Number.isFinite(entry.distance)) continue;
    const key = `${entry.deliveryX},${entry.deliveryY}`;
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(["go_drop_off", entry.deliveryX, entry.deliveryY]);
  }

  return options;
}

/*
 * Updates the intention queue with sensible options for the current moment.
 */
export function optionsGeneration(agent, bs) {
  // In directive mode the BDI does only what the LLM tells it; normal scored
  // options must not compete with (or preempt) the coordination intention.
  if (bs.coordination?.active) return;

  const { me, parcels } = bs;
  const deliveryDistanceMap = bs.map.deliveryDistanceMap;

  if (
    !me?.id ||
    me.x == null ||
    me.y == null ||
    !Array.isArray(deliveryDistanceMap) ||
    deliveryDistanceMap.length === 0
  ) {
    return;
  }

  const options = [];

  for (const option of generatePickupOptions(parcels, me, bs) ?? []) {
    options.push(option);
  }

  for (const option of generateDeliveryOptions(parcels, me, bs)) {
    options.push(option);
  }

  // When camping is enabled, keep a camp option in the queue so it can compete
  // by score — including against delivery while carrying (its scoring gate and
  // loss budget live in intentionScore). Invalid camps (full / budget spent)
  // self-filter out of the queue, so this is harmless when not applicable.
  if (AGENT_CONFIG.behavior.camp) {
    options.push(["camp"]);
  }

  // One batched insert: pushBatch filters out failed-pool and already-queued
  // predicates and re-sorts exactly once (instead of once per pushed option).
  agent.pushBatch(options);
}
