import {
  Intention,
  samePredicateInQueue,
  isPreemptedIntentionError,
  isStoppedIntentionError,
  STOP_REASON_PREEMPTION,
} from "./intention.js";
import {
  optionsGeneration,
  distanceFactor,
  pickupRouteDistance,
  raceWinProbability,
  effectiveCapacity,
  campPatienceMs,
  EXPLORATION_INCENTIVE,
  CAMP_INCENTIVE,
  DROP_DISINCENTIVE,
} from "./options.js";
import {
  deliveryMapDistance,
  nearestDeliveryTileAt,
} from "../utils/stateUtils.js";
import {
  applyParcelValueBand,
  adjustDeliveryScore,
  applyStackModifier,
  stackDeliveryModifier,
  stackPickupModifier,
  stackCampGain,
} from "./ruleScoring.js";
import {
  RUNTIME,
  PREEMPTION_HYSTERESIS,
  PREEMPTION_EPSILON,
  CAMP_LOSS_BUDGET_FRACTION,
  CAMP_NEAR_DELIVERY_TILES,
  COORD_RESUME_IDLE_TTL_MS,
} from "../utils/constants.js";
import { waitUntil } from "../utils/asyncUtils.js";
import { setupBdiCoordination } from "./coordination.js";

// ==========================================
// Coordination
// ==========================================

/*
 * Translates an LLM coordination directive into a BDI predicate the existing
 * executePredicate already understands. `resume` is handled in #runCoordination,
 * not here.
 */
function coordToPredicate({ command, args = {} }) {
  switch (command) {
    case "go_to":
      return ["go_to", args.x, args.y];
    case "go_near":
      return ["go_near", args.x, args.y, args.maxDist];
    case "pickup":
      return ["go_pick_up", args.x, args.y, args.parcelId];
    case "putdown":
      return ["go_drop_off", args.x, args.y];
    case "wait":
      return ["wait", args.signal, args.timeoutMs];
    default:
      throw `Unknown coordination command: ${command}`;
  }
}

// ==========================================
// Readiness check
// ==========================================

/*
 * Checks that the BDI has enough state to start.
 */
function isReady(bs) {
  return (
    bs.me.id != null &&
    bs.me.x != null &&
    bs.me.y != null &&
    Array.isArray(bs.map.deliveryDistanceMap) &&
    bs.map.deliveryDistanceMap.length > 0
  );
}

// ==========================================
// IntentionRevision (base)
// ==========================================

class IntentionRevision {
  #intentionQueue = [];
  #currentIntention = null;
  // key -> { predicate, addedAtMs, cooldownMs }: predicates waiting out a
  // post-failure cooldown.
  #failedIntentionPool = new Map();
  #bs;
  #executePredicate;
  // When true, the autonomous select-and-execute cycle idles: the running
  // intention is preempted (re-queued, not failed) and no new one starts. Used
  // by an embedded owner (the LLM agent) to stop the loop while it interprets a
  // chat message, then resume. Distinct from coordination/directive mode.
  #paused = false;
  // Optional session logger — when set, BDI decisions are written to
  // bdi_decisions.jsonl for post-session analysis.
  #bdiLogger = null;
  // Tracks the predicate key of the last queue winner to detect rank changes.
  #lastTopKey = null;

  /*
   * Initializes intention revision with state and executor.
   * bdiLogger: optional session logger (from historyLogger.js); null for standalone BDI.
   */
  constructor(bs, executePredicate, bdiLogger = null) {
    this.#bs = bs;
    this.#executePredicate = executePredicate;
    this.#bdiLogger = bdiLogger;
  }

  /*
   * Stops the autonomous cycle and preempts the running intention (re-queued,
   * not failed, via the existing preemption path). Safe to call before the loop
   * has started — it only sets a flag the loop honors on its next pass.
   */
  pause() {
    this.#paused = true;
    if (this.#currentIntention) {
      this.#currentIntention.stop(STOP_REASON_PREEMPTION);
    }
  }

  /*
   * Resumes the autonomous cycle after a pause().
   */
  resume() {
    this.#paused = false;
  }

  /*
   * Returns the current intention queue.
   */
  get intention_queue() {
    return this.#intentionQueue;
  }

  /*
   * Prints agent logs with its name.
   */
  log(...args) {
    console.log(`[${this.#bs.me.name ?? "BDI"}]`, ...args);
  }

  /*
   * Creates a simple key to compare two predicates.
   */
  #predicateKey(predicate) {
    return predicate.join(" ");
  }

  /*
   * Checks whether the predicate is still on cooldown after a failure.
   */
  isPredicateInFailedPool(predicate) {
    return this.#failedIntentionPool.has(this.#predicateKey(predicate));
  }

  /*
   * Stores a failed intention so it is filtered from the queue for a short,
   * flat cooldown, then retried. No exponential backoff: a failure is almost
   * always transient congestion that clears within a moment (see
   * RUNTIME.FAILED_INTENTION_RETRY_MS), so every predicate — pickup, delivery
   * or explore — re-probes at the same steady interval.
   */
  #recordFailedIntention(predicate) {
    this.#failedIntentionPool.set(this.#predicateKey(predicate), {
      predicate: [...predicate],
      addedAtMs: Date.now(),
      cooldownMs: RUNTIME.FAILED_INTENTION_RETRY_MS,
    });
  }

  /*
   * A failed delivery must not leave the agent without any delivery option
   * while parcels keep decaying: push the next-nearest other delivery tile
   * right away. It competes by score like any other intention — the point
   * is only that the queue is never empty of deliveries during a cooldown.
   * (Pickups need no equivalent: the other parcels' options are regenerated
   * on every belief update, only the failed key stays filtered.)
   */
  #pushNextNearestDelivery(failedPredicate) {
    const me = this.#bs.me;
    const row = this.#bs.map.deliveryDistanceMap?.[Math.round(me.y)];
    const entries = row?.[Math.round(me.x)];
    if (!Array.isArray(entries)) return;

    const [, failedX, failedY] = failedPredicate;

    const candidates = entries
      .filter((entry) => Number.isFinite(entry.distance))
      .filter(
        (entry) =>
          !(entry.deliveryX === failedX && entry.deliveryY === failedY)
      )
      .sort((a, b) => a.distance - b.distance);

    for (const entry of candidates) {
      const predicate = ["go_drop_off", entry.deliveryX, entry.deliveryY];
      if (this.isPredicateInFailedPool(predicate)) continue;
      this.push(predicate);
      return;
    }
  }

  /*
   * Re-queues failed intentions when the cooldown expires.
   */
  #requeueFailedIntentions() {
    const now = Date.now();
    let requeued = false;

    for (const [key, entry] of this.#failedIntentionPool.entries()) {
      if (now - entry.addedAtMs < entry.cooldownMs) continue;

      this.#failedIntentionPool.delete(key);

      if (
        this.#currentIntention &&
        this.#predicateKey(this.#currentIntention.predicate) === key
      ) {
        continue;
      }

      if (samePredicateInQueue(this.intention_queue, entry.predicate)) continue;

      this.intention_queue.push(this.createIntention(entry.predicate));
      requeued = true;
    }

    if (requeued) this.sortQueueByScore();
  }

  /*
   * Assigns a score to each predicate based on the current context.
   *
   * The pickup-vs-delivery balance is implicit in the difference of the two
   * scores: both subtract a loss term, but over different distances (full
   * pickup route vs direct delivery route), so every carried parcel makes a
   * detour cost distanceFactor per extra tile. The bar for "one more
   * pickup" therefore rises with the carried count, matching the real decay
   * economics — provided distanceFactor is sound, which the event-based
   * decay model guarantees.
   */
  /*
   * Scores a predicate given the current belief state.
   * When `out` is provided (a plain object), it is populated with intermediate
   * values so callers can log exactly why a score was computed — useful for
   * post-session debugging without adding overhead to the hot path.
   */
  intentionScore(predicate, out = null) {
    const me = this.#bs.me;
    const parcels = this.#bs.parcels;
    const deliveryDistanceMap = this.#bs.map.deliveryDistanceMap;

    const myParcels = [...parcels.values()].filter(
      (p) => p.carriedBy === me.id
    );
    const totalReward = myParcels.reduce((sum, p) => sum + p.reward, 0);
    const factor = distanceFactor(this.#bs);

    const action = predicate[0];

    if (action === "go_drop_off") {
      const [, x, y] = predicate;
      const routeDist = deliveryMapDistance(
        deliveryDistanceMap,
        { x: me.x, y: me.y },
        { x, y }
      );
      if (routeDist == null) { if (out) out.reason = "unreachable"; return -1; }

      // Per-parcel delivered value: its current reward minus decay over the
      // delivery route, floored at 0, then remapped by any parcel-value rule
      // (e.g. "worth over 10 at delivery -> 0 pts"). With no value rule this
      // sums to the old `totalReward - estimatedLoss`.
      let sumBanked = -DROP_DISINCENTIVE;
      const parcelDetails = out ? [] : null;
      for (const parcel of myParcels) {
        const projected = Math.max(0, parcel.reward - routeDist * factor);
        const banked = applyParcelValueBand(projected, this.#bs.rules);
        sumBanked += banked;
        if (parcelDetails) {
          parcelDetails.push({ id: parcel.id, reward: parcel.reward, projected, banked });
        }
      }

      // Soft stack-size value: penalise/reward this delivery by how the carried
      // count meets the rule's target (met vs unmet modifier). No gate — a
      // penalty just lowers the score so camp/gathering can outrank a premature
      // delivery; a met bonus lifts it so a completed stack is banked promptly.
      const stackMod = stackDeliveryModifier(myParcels.length, this.#bs.rules);
      const scoreAfterStack = applyStackModifier(sumBanked, stackMod);
      // Persistent delivery-tile preferences steer which delivery wins, without
      // ever gating: a preferred tile scores higher, a penalised one lower.
      // adjustDeliveryScore floors at 0, so neither preference can strand.
      const finalScore = adjustDeliveryScore(scoreAfterStack, this.#bs.rules, x, y);

      if (out) {
        out.routeDist = routeDist;
        out.factor = factor;
        out.carriedCount = myParcels.length;
        out.parcels = parcelDetails;
        out.sumBanked = sumBanked;
        out.stackMod = stackMod;
        out.scoreAfterStack = scoreAfterStack;
        const key = `${x},${y}`;
        out.tileMultiplier  = this.#bs.rules?.deliveryMultipliers?.get(key) ?? 1;
        out.tileReward      = this.#bs.rules?.preferredDeliveries?.get(key)?.reward ?? 0;
        out.tilePenalty     = this.#bs.rules?.penaltyDeliveries?.get(key)?.penalty ?? 0;
        out.finalScore = finalScore;
      }

      return finalScore;
    }

    if (action === "go_pick_up") {
      const [, , , parcelId] = predicate;
      const newParcel = parcels.get(parcelId);
      if (!newParcel) { if (out) out.reason = "parcel_gone"; return -1; }

      // No pickup gate on value: a parcel is valued by what it will BANK at
      // delivery (the parcel-value rule), not excluded at pickup.

      // A full agent gains nothing from pickups: delivery becomes the only
      // scored option. The cap also guarantees banking when parcels do not
      // decay (where the rising detour bar above vanishes).
      if (myParcels.length >= effectiveCapacity(this.#bs)) {
        if (out) out.reason = "at_capacity";
        return -1;
      }

      const routeDist = pickupRouteDistance(newParcel, me, this.#bs);
      if (routeDist == null) { if (out) out.reason = "unreachable"; return -1; }

      // Stack-aware (approach b): value the pickup by the delivery it leads to
      // at the resulting carried count. Gathering toward the target is valued
      // optimistically (met); only overshooting an exactly/at_most cap is
      // priced with the unmet modifier, so a rich enough parcel can still win.
      const pickupMod = stackPickupModifier(
        myParcels.length + 1,
        this.#bs.rules
      );

      // New parcel's delivered value (its reward minus decay over the route),
      // remapped by the value rule, THEN discounted by the chance of winning the
      // race for it. Order matters: the value-band threshold must see the
      // parcel's TRUE delivered value. Folding the race probability in first can
      // push a high-value parcel into a "worth 0" band (e.g. a 35pt parcel under
      // "delivered under 25 -> 0" the moment any agent contests it), making the
      // agent wrongly skip it and idle. Race is an acquisition probability, so it
      // scales the banked value — it must not decide which band the parcel is in.
      const raceProb = raceWinProbability(newParcel, me, this.#bs);
      const newProjected = Math.max(0, newParcel.reward - routeDist * factor);
      const newDelivered =
        applyParcelValueBand(newProjected, this.#bs.rules) * raceProb;

      // Already-carried parcels are also remapped at the (later) delivery.
      let carriedDelivered = 0;
      if (myParcels.length > 0) {
        for (const parcel of myParcels) {
          carriedDelivered += applyParcelValueBand(
            Math.max(0, parcel.reward - routeDist * factor),
            this.#bs.rules
          );
        }
      }
      const pickupFinalScore = applyStackModifier(
        carriedDelivered + newDelivered,
        pickupMod
      );

      if (out) {
        out.parcelId      = newParcel.id;
        out.parcelReward  = newParcel.reward;
        out.routeDist     = routeDist;
        out.factor        = factor;
        out.raceProb      = raceProb;
        out.newProjected  = newProjected;
        out.newDelivered  = newDelivered;
        out.pickupMod     = pickupMod;
        out.carriedCount  = myParcels.length;
        out.carriedDelivered = carriedDelivered;
        out.finalScore    = pickupFinalScore;
      }

      return pickupFinalScore;
    }

    if (action === "explore") {
      if (out) out.finalScore = EXPLORATION_INCENTIVE;
      return EXPLORATION_INCENTIVE;
    }

    if (action === "camp") {
      // Camp is viable only while the pocket is still "hot" — a parcel was
      // picked up within the pocket's adaptive patience window (longer for dense
      // spawn clusters, near-zero for isolated tiles / non-spawning maps). Once
      // it goes cold the score drops to invalid, so a distinct `explore`
      // intention (empty-handed) or delivery (carrying) takes over. Camp never
      // performs exploration itself.
      const hint = this.#bs.lastParcelHint;
      if (!hint) {
        if (out) { out.reason = "no_hint"; out.finalScore = -1; }
        return -1;
      }
      const patienceMs = campPatienceMs(this.#bs, hint);
      const elapsedMs = Date.now() - hint.ts;
      const hot = patienceMs > 0 && elapsedMs < patienceMs;
      if (!hot) {
        if (out) { out.patienceMs = patienceMs; out.elapsedMs = elapsedMs; out.hot = false; out.reason = "pocket_cold"; out.finalScore = -1; }
        return -1;
      }

      const carriedCount = myParcels.length;

      // Idle camp: a tiny incentive, just above exploration.
      if (carriedCount === 0) {
        if (out) { out.patienceMs = patienceMs; out.elapsedMs = elapsedMs; out.hot = true; out.carriedCount = 0; out.reason = "idle_camp"; out.finalScore = CAMP_INCENTIVE; }
        return CAMP_INCENTIVE;
      }

      // Carrying: camping for more is only worth it under capacity and while
      // still within the decay loss budget. Otherwise deliver.
      if (carriedCount >= effectiveCapacity(this.#bs)) {
        if (out) { out.patienceMs = patienceMs; out.elapsedMs = elapsedMs; out.hot = true; out.carriedCount = carriedCount; out.reason = "at_capacity"; out.finalScore = -1; }
        return -1;
      }

      // Don't camp for a fuller load when a delivery tile is right here: the
      // payoff of gathering more is amortizing a long trip, so when delivery is
      // near, quick pickup→deliver cycles win. Deliver instead of loitering.
      const nearestDelivery = nearestDeliveryTileAt(me, deliveryDistanceMap);
      if (nearestDelivery && nearestDelivery.distance <= CAMP_NEAR_DELIVERY_TILES) {
        if (out) { out.patienceMs = patienceMs; out.elapsedMs = elapsedMs; out.hot = true; out.carriedCount = carriedCount; out.nearDeliveryDist = nearestDelivery.distance; out.reason = "delivery_near"; out.finalScore = -1; }
        return -1;
      }

      let campSteps, horizon, baseBudget, stackGain;
      if (factor > 0) {
        campSteps = this.#bs.carry?.campSteps ?? 0;
        // Base budget: tiles we may camp before bleeding > a fraction of the
        // carried value to decay.
        baseBudget = CAMP_LOSS_BUDGET_FRACTION * totalReward;
        // Stack-aware extension: if GATHERING MORE could raise the delivery
        // value (reaching an at_least/exactly target, or its met bonus), we may
        // bleed up to that extra value too — so "wait for spawns" lasts exactly
        // as long as completing the stack is worth. stackCampGain only counts
        // gains reachable by adding parcels, so an already-exceeded at_most cap
        // (which camping can never undo) adds nothing.
        stackGain = stackCampGain(
          carriedCount,
          totalReward,
          this.#bs.rules,
          effectiveCapacity(this.#bs)
        );
        horizon = Math.max(baseBudget, stackGain) / (factor * carriedCount);
        if (campSteps >= horizon) {
          if (out) { out.patienceMs = patienceMs; out.elapsedMs = elapsedMs; out.hot = true; out.carriedCount = carriedCount; out.campSteps = campSteps; out.horizon = horizon; out.baseBudget = baseBudget; out.stackGain = stackGain; out.totalReward = totalReward; out.reason = "budget_exhausted"; out.finalScore = -1; }
          return -1;
        }
      }

      // Eligible: outrank delivery (≈ totalReward) so the agent gathers a
      // fuller load first, but stay below any real pickup (totalReward + the
      // new parcel's reward), so visible parcels are still grabbed first.
      const campScore = totalReward + CAMP_INCENTIVE;
      if (out) {
        out.patienceMs = patienceMs;
        out.elapsedMs = elapsedMs;
        out.hot = true;
        out.carriedCount = carriedCount;
        out.totalReward = totalReward;
        if (campSteps != null)  { out.campSteps = campSteps; out.horizon = horizon; out.baseBudget = baseBudget; out.stackGain = stackGain; }
        out.finalScore = campScore;
      }
      return campScore;
    }

    return 0;
  }

  /*
   * Reorders the queue keeping the most promising intentions at the front.
   * Preemption uses hysteresis: the running intention is a commitment, and
   * abandoning a half-walked route has a real cost in tiles, so a
   * challenger must be clearly better — not 0.001 better — to interrupt.
   * This also protects deliveries in final approach naturally: the drop
   * score peaks right before the tile, making the bar highest exactly when
   * switching would hurt the most.
   */
  sortQueueByScore() {
    const running = this.#currentIntention;
    const hasLogger = !!this.#bdiLogger;

    const scored = this.intention_queue.map((intention, index) => {
      const breakdown = hasLogger ? {} : null;
      const score = this.intentionScore(intention.predicate, breakdown);
      return { intention, index, score, breakdown };
    });

    // Every option — deliveries included — must score strictly > 0 to stay.
    // This lets a hard block work: a forbidden delivery tile is pinned to 0 by
    // the floored penalty (adjustDeliveryScore) and is now dropped rather than
    // kept. The agent can never end up frozen: the idle loop injects `explore`
    // (a flat EXPLORATION_INCENTIVE > 0) whenever the queue empties, so when no
    // pickup/delivery/camp is valid it wanders instead of stalling. The cost is
    // that a delivery zeroed purely by decay is also discarded, so the agent
    // will hold fully-decayed parcels and explore rather than dump them.
    const valid = scored.filter((e) => e.score > 0);
    valid.sort((a, b) =>
      b.score !== a.score ? b.score - a.score : a.index - b.index
    );

    this.intention_queue.splice(
      0,
      this.intention_queue.length,
      ...valid.map((e) => e.intention)
    );

    // Diagnostic: dump the queue in its freshly sorted order, each entry with
    // the score that placed it there.
    this.log(
      "Queue resorted:",
      valid.length === 0
        ? "(empty)"
        : valid
            .map((e) => `${e.intention.predicate.join(" ")}=${e.score.toFixed(2)}`)
            .join(" | ")
    );

    // Log the full ranked queue + winner breakdown to bdi_decisions.jsonl.
    if (hasLogger) {
      const topKey = valid.length > 0 ? valid[0].intention.predicate.join(" ") : null;
      const topChanged = topKey !== this.#lastTopKey;
      this.#lastTopKey = topKey;

      this.#bdiLogger.logBdiEvent("bdi_queue_sort", {
        queue: valid.map((e) => ({
          predicate: e.intention.predicate,
          score: parseFloat(e.score.toFixed(4)),
        })),
        winnerBreakdown: valid.length > 0 ? valid[0].breakdown : null,
        running: running?.predicate ?? null,
        topChanged,
        droppedCount: scored.length - valid.length,
      });
    }

    const best = this.intention_queue[0];
    // A committed PDDL maneuver (e.g. pushing a crate out of the way) must not
    // be preempted: it temporarily lowers its own score by detouring, and
    // restarting it from scratch wastes the partial push. Let it finish.
    if (running && best && running !== best && !this.#bs.committedManeuver) {
      const runningScore = this.intentionScore(running.predicate);
      const challengerScore = this.intentionScore(best.predicate);

      // An invalid running intention (score <= 0) is abandoned immediately;
      // a valid one only for a clearly better challenger.
      const threshold =
        runningScore > 0
          ? runningScore * (1 + PREEMPTION_HYSTERESIS) + PREEMPTION_EPSILON
          : 0;

      if (challengerScore > threshold) {
        this.log("Preemption: stopping current intention");
        if (hasLogger) {
          this.#bdiLogger.logBdiEvent("bdi_preemption", {
            stopped:          running.predicate,
            stoppedScore:     parseFloat(runningScore.toFixed(4)),
            challenger:       best.predicate,
            challengerScore:  parseFloat(challengerScore.toFixed(4)),
            threshold:        parseFloat(threshold.toFixed(4)),
          });
        }
        running.stop(STOP_REASON_PREEMPTION);
      }
    }
  }

  /*
   * Builds a new intention ready for the queue.
   */
  createIntention(predicate) {
    return new Intention(this, predicate, this.#executePredicate);
  }

  /*
   * Removes an intention from the current queue.
   */
  removeIntention(intention) {
    const index = this.intention_queue.indexOf(intention);
    if (index !== -1) this.intention_queue.splice(index, 1);
  }

  /*
   * Interrupts the running normal intention so the loop can switch into
   * coordination on its next pass. Called by setupBdiCoordination when a
   * directive arrives. Uses the existing preemption path, so the interrupted
   * intention is re-queued (not failed) and competes again after `resume`.
   */
  preemptForCoordination() {
    if (this.#currentIntention) {
      this.#currentIntention.stop(STOP_REASON_PREEMPTION);
    }
  }

  /*
   * One pass of directive mode: execute the next queued directive (or idle).
   * Runs the directive through the existing executePredicate and reports a
   * status back to the LLM, matched by cid. `resume` exits directive mode.
   */
  async #runCoordination() {
    const c = this.#bs.coordination;

    if (c.queue.length === 0) {
      // Active but nothing to do. Defensive auto-resume if the LLM went away.
      if (c.lastActivityMs && Date.now() - c.lastActivityMs > COORD_RESUME_IDLE_TTL_MS) {
        this.log("coordination idle past TTL — auto-resuming");
        c.active = false;
      }
      await new Promise((res) => setTimeout(res, 50));
      return;
    }

    const directive = c.queue.shift();
    c.current = directive;
    c.lastActivityMs = Date.now();

    if (directive.command === "resume") {
      c.active = false;
      c.current = null;
      c.sendStatus?.({ cid: directive.cid, ok: true });
      return;
    }

    let ok = true;
    let detail;
    try {
      await this.#executePredicate(coordToPredicate(directive), {
        shouldStop: () => false,
      });
    } catch (error) {
      ok = false;
      detail =
        typeof error === "string" ? error : error?.message ?? String(error);
      this.log("coordination directive failed", directive.command, detail);
    }

    c.current = null;
    c.sendStatus?.({ cid: directive.cid, ok, detail });
  }

  /*
   * Keeps alive the cycle that selects and executes intentions.
   */
  async loop() {
    while (true) {
      // Paused by an embedded owner (the LLM agent handling a chat message).
      // Idle without scoring or executing until resume().
      if (this.#paused) {
        await new Promise((res) => setTimeout(res, 50));
        continue;
      }

      // Directive mode overrides scoring: do only what the LLM commands.
      if (this.#bs.coordination?.active) {
        await this.#runCoordination();
        continue;
      }

      this.#requeueFailedIntentions();

      if (this.intention_queue.length > 0) {
        const intention = this.intention_queue[0];
        const [action] = intention.predicate;

        if (action === "go_pick_up") {
          const parcelId = intention.predicate[3];
          const parcel = this.#bs.parcels.get(parcelId);
          if (!parcel || parcel.carriedBy) {
            this.log("Skipping invalid intention", intention.predicate);
            this.#bdiLogger?.logBdiEvent("bdi_intention_skip", {
              predicate: intention.predicate,
              reason: parcel ? "parcel_carried" : "parcel_gone",
            });
            this.removeIntention(intention);
            await new Promise((res) => setImmediate(res));
            continue;
          }
        }

        if (action === "go_drop_off") {
          const carrying = (this.#bs.carry?.count ?? 0) > 0;
          if (!carrying) {
            this.log("Skipping invalid intention", intention.predicate);
            this.#bdiLogger?.logBdiEvent("bdi_intention_skip", {
              predicate: intention.predicate,
              reason: "not_carrying",
            });
            this.removeIntention(intention);
            await new Promise((res) => setImmediate(res));
            continue;
          }
        }

        this.#currentIntention = intention;
        let keepIntentionInQueue = false;
        let intentionOutcome = "completed";
        const intentionStartMs = Date.now();

        if (this.#bdiLogger) {
          const startBreakdown = {};
          const startScore = this.intentionScore(intention.predicate, startBreakdown);
          this.#bdiLogger.logBdiEvent("bdi_intention_start", {
            predicate: intention.predicate,
            score: parseFloat(startScore.toFixed(4)),
            breakdown: startBreakdown,
          });
        }

        await intention
          .achieve()
          .catch((error) => {
            const wasPreempted = isPreemptedIntentionError(error);
            const wasStopped = isStoppedIntentionError(error);

            if (wasPreempted) {
              intentionOutcome = "preempted";
              const index = this.intention_queue.indexOf(intention);
              if (index !== -1) {
                this.intention_queue.splice(
                  index,
                  1,
                  this.createIntention(intention.predicate)
                );
                keepIntentionInQueue = true;
              }
              return;
            }

            if (!wasStopped) {
              intentionOutcome = "failed";
              this.#recordFailedIntention(intention.predicate);

              if (intention.predicate[0] === "go_drop_off") {
                this.#pushNextNearestDelivery(intention.predicate);
              }
            } else {
              intentionOutcome = "stopped";
            }
          })
          .finally(() => {
            this.#bdiLogger?.logBdiEvent("bdi_intention_end", {
              predicate: intention.predicate,
              outcome: intentionOutcome,
              durationMs: Date.now() - intentionStartMs,
            });
            if (this.#currentIntention === intention) {
              this.#currentIntention = null;
            }
          });

        if (!keepIntentionInQueue) {
          this.removeIntention(intention);
        }
      } else {
        // Idle baseline: explore. When camping is enabled, optionsGeneration
        // also queues a `camp` option that outranks explore while a pocket is
        // hot; when the pocket goes cold, explore takes over here again.
        this.#bdiLogger?.logBdiEvent("bdi_idle", { pushed: "explore" });
        this.push(["explore"]);
      }

      await new Promise((res) => setImmediate(res));
    }
  }
}

// ==========================================
// IntentionRevisionRevise
// ==========================================

class IntentionRevisionRevise extends IntentionRevision {
  constructor(bs, executePredicate, bdiLogger = null) {
    super(bs, executePredicate, bdiLogger);
  }

  /*
   * Inserts a new predicate if it is not already present or blocked.
   */
  async push(predicate) {
    if (this.isPredicateInFailedPool(predicate)) return;
    if (samePredicateInQueue(this.intention_queue, predicate)) return;

    const intention = this.createIntention(predicate);
    this.intention_queue.push(intention);
    this.sortQueueByScore();
  }

  /*
   * Inserts a batch of predicates and re-sorts the queue exactly once.
   * Used by optionsGeneration so a full belief update costs one sort instead
   * of one per generated option. Always re-sorts (even when nothing new is
   * added) so time-varying scores — a camp pocket going cold, decay drift —
   * are still re-evaluated each reconsideration tick.
   */
  pushBatch(predicates) {
    for (const predicate of predicates) {
      if (this.isPredicateInFailedPool(predicate)) continue;
      if (samePredicateInQueue(this.intention_queue, predicate)) continue;
      this.intention_queue.push(this.createIntention(predicate));
    }
    this.sortQueueByScore();
  }
}

// ==========================================
// Entry point
// ==========================================

/*
 * Builds the autonomous select-and-execute agent on a belief state and starts
 * its supervised intention loop once beliefs are ready. Returns the agent
 * synchronously (readiness wait + loop launch run in the background) so callers
 * can hold the handle — e.g. to pause()/resume() it — immediately. Does NOT
 * wire partner coordination; an owner that needs directives-over-the-wire (the
 * paired BDI) layers setupBdiCoordination on top.
 */
export function startAutonomousBDI(bs, actions, bdiLogger = null) {
  const agent = new IntentionRevisionRevise(bs, actions.executePredicate, bdiLogger);

  (async () => {
    console.log(`[${bs.me.name ?? "BDI"}] Waiting for initial beliefs...`);

    await waitUntil(() => isReady(bs), RUNTIME.READINESS_CHECK_DELAY_MS);

    console.log(`[${bs.me.name ?? "BDI"}] Agent ready`);

    wireReconsideration(bs, agent);
    superviseLoop(bs, agent);
  })();

  return agent;
}

/*
 * Starts the BDI agent and connects updates to the internal state.
 */
export async function startBDIAgent(socket, bs, actions) {
  const agent = startAutonomousBDI(bs, actions);

  // Give the BDI a message channel to its LLM partner (directives in, status out).
  setupBdiCoordination(socket, bs, agent);

  return agent;
}

/*
 * Wires rate-limited reconsideration onto the belief state. Every decay tick of
 * every visible parcel fires a sensing event; regenerating and re-sorting
 * options on each one caused continuous preemption churn. Reconsider
 * immediately only on a significant change (the set of free or carried parcels
 * changed), otherwise at most every RECONSIDERATION_MIN_INTERVAL_MS.
 */
function wireReconsideration(bs, agent) {
  let lastSignature = "";
  let lastGenerationMs = 0;

  bs.onUpdate = () => {
    const freeIds = [];
    const carriedIds = [];
    for (const parcel of bs.parcels.values()) {
      if (parcel.carriedBy === bs.me.id) carriedIds.push(parcel.id);
      else if (!parcel.carriedBy) freeIds.push(parcel.id);
    }
    const signature =
      `${freeIds.sort().join(",")}|${carriedIds.sort().join(",")}`;

    const nowMs = Date.now();
    if (
      signature === lastSignature &&
      nowMs - lastGenerationMs < RUNTIME.RECONSIDERATION_MIN_INTERVAL_MS
    ) {
      return;
    }

    lastSignature = signature;
    lastGenerationMs = nowMs;
    // optionsGeneration ends in a single pushBatch, which always re-sorts —
    // including when the option set is unchanged — so time-varying scores (a
    // camp pocket going cold, decay drift) are re-evaluated each tick without
    // a second explicit sort. Hysteresis still guards against churn.
    //
    // This runs synchronously inside a socket sensing event. A collision emits
    // a burst of agent-position sensing events, so any throw in option
    // generation/scoring here would otherwise propagate into the socket emitter
    // and tear down the agent. Contain it: a bad reconsideration tick must not
    // kill sensing — the next tick re-runs it cleanly.
    try {
      optionsGeneration(agent, bs);
    } catch (error) {
      console.error(
        `[${bs.me.name ?? "BDI"}] optionsGeneration failed on sensing update:`,
        error
      );
    }
  };
}

/*
 * Supervise the intention loop. `loop()` protects each intention's execution
 * with its own try/catch, but the surrounding while-body (requeue, queue
 * edits, the failure-recovery push on a blocked delivery) runs unprotected;
 * if any of it throws, the loop's promise rejects. Launched bare, that
 * rejection is unhandled — under Node it kills the process and the agent
 * never restarts (most often seen after a delivery is blocked by a
 * collision). Relaunch on rejection so the agent resumes: the same `agent`
 * is reused, so the intention queue, failed-intention pool and beliefs all
 * survive the restart. The logged error pins the exact trigger.
 */
function superviseLoop(bs, agent) {
  const runLoop = () => {
    agent.loop().catch((error) => {
      console.error(
        `[${bs.me.name ?? "BDI"}] intention loop crashed — restarting:`,
        error
      );
      runLoop();
    });
  };
  runLoop();
}
