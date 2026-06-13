import { parseDurationMs } from "./stateUtils.js";
import {
  DEFAULT_MOVEMENT_DURATION_MS,
  DEFAULT_DECAY_INTERVAL_MS,
  DECAY_EMA_ALPHA,
} from "./constants.js";

/*
 * Event-based decay model.
 *
 * The quantity every score needs is one number: decayPerStep = reward points
 * lost per tile of travel, per carried parcel. It is estimated purely from
 * server events, with no wall clock anywhere in the scoring path:
 *
 *  - every server decay tick is visible as a -1 on sensed parcels' rewards
 *    (counted into bs.timing.decayTicks by the belief update);
 *  - every completed step is visible as a move acknowledgment;
 *  - the number of ticks that land between two consecutive move-acks of the
 *    same path is a direct sample of decay-per-step (sampled in executePath
 *    and smoothed here with an EMA).
 *
 * This automatically prices in every slowness source (client computation,
 * network round-trips, retries, congestion): a longer step necessarily
 * contains more ticks, by definition. Server lag cancels (slow server =
 * fewer ticks AND slower acks). Idle/deliberation time cannot poison the
 * estimate because only windows between consecutive acks inside a running
 * path are counted.
 *
 * The EMA is seeded from the server-declared config
 * (movement_duration / decaying_event) so scores are sane during warm-up.
 */

/*
 * Decay interval in ms as declared by the server.
 * Returns Infinity when parcels do not decay ('infinite').
 */
export function decayIntervalMs(bs) {
  const declared = bs?.config?.parcelDecayingEvent;

  if (typeof declared === "string" && declared.trim().toLowerCase() === "infinite") {
    return Infinity;
  }

  const parsed = parseDurationMs(declared);
  if (parsed != null && parsed > 0) return parsed;

  return DEFAULT_DECAY_INTERVAL_MS;
}

/*
 * Movement duration in ms as declared by the server.
 */
export function movementDurationMs(bs) {
  const parsed = parseDurationMs(bs?.config?.movementDuration);
  if (parsed != null && parsed > 0) return parsed;
  return DEFAULT_MOVEMENT_DURATION_MS;
}

/*
 * Whether parcels decay at all on this server.
 */
export function decayEnabled(bs) {
  return Number.isFinite(decayIntervalMs(bs));
}

/*
 * Warm-up prior: decay-per-step derived from the declared config only.
 * 0 when parcels do not decay.
 */
export function configDecayPerStep(bs) {
  const interval = decayIntervalMs(bs);
  if (!Number.isFinite(interval)) return 0;
  return movementDurationMs(bs) / interval;
}

/*
 * Current best estimate of decay-per-step: the measured EMA when available,
 * the config prior otherwise.
 */
export function getDecayPerStep(bs) {
  if (!decayEnabled(bs)) return 0;
  return bs?.timing?.decayPerStep ?? configDecayPerStep(bs);
}

/*
 * Feeds one decay-per-step sample (decay ticks observed between two
 * consecutive move-acks of the same path) into the EMA.
 */
export function recordStepDecaySample(bs, ticksInStep) {
  if (!decayEnabled(bs)) return;
  if (!Number.isFinite(ticksInStep) || ticksInStep < 0) return;

  const previous = bs.timing.decayPerStep ?? configDecayPerStep(bs);
  bs.timing.decayPerStep =
    DECAY_EMA_ALPHA * ticksInStep + (1 - DECAY_EMA_ALPHA) * previous;
}
