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
  competitionAdjustedReward,
  effectiveCapacity,
  campPatienceMs,
  EXPLORATION_INCENTIVE,
  CAMP_INCENTIVE,
  DROP_DISINCENTIVE,
} from "./options.js";
import { deliveryMapDistance } from "../utils/stateUtils.js";
import {
  RUNTIME,
  PREEMPTION_HYSTERESIS,
  PREEMPTION_EPSILON,
  CAMP_LOSS_BUDGET_FRACTION,
} from "../utils/constants.js";
import { waitUntil } from "../utils/asyncUtils.js";

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
  // key -> { failures, lastFailureAtMs }: kept separately from the pool
  // (whose entries are deleted on requeue) so repeated failures of the same
  // predicate can grow the cooldown exponentially.
  #failureStats = new Map();
  #bs;
  #executePredicate;

  /*
   * Initializes intention revision with state and executor.
   */
  constructor(bs, executePredicate) {
    this.#bs = bs;
    this.#executePredicate = executePredicate;
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
   * Stores a failed intention to retry it later.
   * The cooldown doubles at each repeated failure of the same predicate
   * (3s -> 6s -> 12s, capped): transient blocks recover quickly while
   * genuinely unreachable targets stop being hammered. The failure counter
   * restarts after a quiet period, so an old failure does not penalize a
   * target forever.
   */
  #recordFailedIntention(predicate) {
    const key = this.#predicateKey(predicate);
    const nowMs = Date.now();

    const stats = this.#failureStats.get(key);
    const failures =
      stats && nowMs - stats.lastFailureAtMs < RUNTIME.FAILURE_STATS_RESET_MS
        ? stats.failures + 1
        : 1;
    this.#failureStats.set(key, { failures, lastFailureAtMs: nowMs });

    const cooldownMs = Math.min(
      RUNTIME.FAILED_INTENTION_RETRY_MS * 2 ** (failures - 1),
      RUNTIME.FAILED_INTENTION_RETRY_MAX_MS
    );

    this.#failedIntentionPool.set(key, {
      predicate: [...predicate],
      addedAtMs: nowMs,
      cooldownMs,
    });
  }

  /*
   * Clears the failure history of a predicate that finally succeeded.
   */
  #clearFailureStats(predicate) {
    this.#failureStats.delete(this.#predicateKey(predicate));
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
  intentionScore(predicate) {
    const me = this.#bs.me;
    const parcels = this.#bs.parcels;
    const deliveryDistanceMap = this.#bs.map.deliveryDistanceMap;

    const myParcels = [...parcels.values()].filter(
      (p) => p.carriedBy === me.id
    );
    const totalReward = myParcels.reduce((sum, p) => sum + p.reward, 0);
    let estimatedLoss = 0;

    const action = predicate[0];

    if (action === "go_drop_off") {
      const [, x, y] = predicate;
      const routeDist = deliveryMapDistance(
        deliveryDistanceMap,
        { x: me.x, y: me.y },
        { x, y }
      );
      if (routeDist == null) return -1;

      for (const parcel of myParcels) {
        estimatedLoss += Math.min(parcel.reward, routeDist * distanceFactor(this.#bs));
      }
      return totalReward - estimatedLoss - DROP_DISINCENTIVE;
    }

    if (action === "go_pick_up") {
      const [, , , parcelId] = predicate;
      const newParcel = parcels.get(parcelId);
      if (!newParcel) return -1;

      // A full agent gains nothing from pickups: delivery becomes the only
      // scored option. The cap also guarantees banking when parcels do not
      // decay (where the rising detour bar above vanishes).
      if (myParcels.length >= effectiveCapacity(this.#bs)) return -1;

      const routeDist = pickupRouteDistance(newParcel, me, this.#bs);
      if (routeDist == null) return -1;

      // Raw reward discounted by the chance of actually getting the parcel
      // (race against closer opponents, crowded zones).
      const expectedReward = competitionAdjustedReward(newParcel, me, this.#bs);

      if (myParcels.length === 0) {
        return expectedReward - routeDist * distanceFactor(this.#bs);
      }

      for (const parcel of myParcels) {
        estimatedLoss += Math.min(parcel.reward, routeDist * distanceFactor(this.#bs));
      }
      return totalReward + expectedReward - routeDist * distanceFactor(this.#bs) - estimatedLoss;
    }

    if (action === "explore") return EXPLORATION_INCENTIVE;

    if (action === "camp") {
      // Camp is viable only while the pocket is still "hot" — a free parcel was
      // seen within the pocket's adaptive patience window (longer for dense
      // spawn clusters, near-zero for isolated tiles / non-spawning maps). Once
      // it goes cold the score drops to invalid, so a distinct `explore`
      // intention (empty-handed) or delivery (carrying) takes over. Camp never
      // performs exploration itself.
      const hint = this.#bs.lastParcelHint;
      if (!hint) return -1;
      const patienceMs = campPatienceMs(this.#bs, hint);
      const hot = patienceMs > 0 && Date.now() - hint.ts < patienceMs;
      if (!hot) return -1;

      const carriedCount = myParcels.length;

      // Idle camp: a tiny incentive, just above exploration.
      if (carriedCount === 0) return CAMP_INCENTIVE;

      // Carrying: camping for more is only worth it under capacity and while
      // still within the decay loss budget. Otherwise deliver.
      if (carriedCount >= effectiveCapacity(this.#bs)) return -1;

      const decayPerStep = distanceFactor(this.#bs);
      if (decayPerStep > 0) {
        const used = this.#bs.carry?.campSteps ?? 0;
        // Steps we may still camp before bleeding > fraction of carried value.
        const horizon =
          (CAMP_LOSS_BUDGET_FRACTION * totalReward) /
          (decayPerStep * carriedCount);
        if (used >= horizon) return -1;
      }

      // Eligible: outrank delivery (≈ totalReward) so the agent gathers a
      // fuller load first, but stay below any real pickup (totalReward + the
      // new parcel's reward), so visible parcels are still grabbed first.
      return totalReward + CAMP_INCENTIVE;
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

    const carrying = [...this.#bs.parcels.values()].some(
      (p) => p.carriedBy === this.#bs.me.id
    );

    const scored = this.intention_queue.map((intention, index) => ({
      intention,
      index,
      score: this.intentionScore(intention.predicate),
    }));

    // While carrying, the best delivery stays in the queue even at score 0
    // (carried parcels that would fully decay en route): erasing it would
    // leave the agent carrying worthless parcels forever with no way to
    // free itself.
    const valid = scored.filter(
      (e) =>
        e.score > 0 ||
        (carrying && e.intention.predicate[0] === "go_drop_off" && e.score >= 0)
    );
    valid.sort((a, b) =>
      b.score !== a.score ? b.score - a.score : a.index - b.index
    );

    this.intention_queue.splice(
      0,
      this.intention_queue.length,
      ...valid.map((e) => e.intention)
    );

    const best = this.intention_queue[0];
    if (running && best && running !== best) {
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
   * Keeps alive the cycle that selects and executes intentions.
   */
  async loop() {
    while (true) {
      this.#requeueFailedIntentions();

      if (this.intention_queue.length > 0) {
        const intention = this.intention_queue[0];
        const [action] = intention.predicate;

        if (action === "go_pick_up") {
          const parcelId = intention.predicate[3];
          const parcel = this.#bs.parcels.get(parcelId);
          if (!parcel || parcel.carriedBy) {
            this.log("Skipping invalid intention", intention.predicate);
            this.removeIntention(intention);
            await new Promise((res) => setImmediate(res));
            continue;
          }
        }

        if (action === "go_drop_off") {
          const carrying = Array.from(this.#bs.parcels.values()).some(
            (p) => p.carriedBy === this.#bs.me.id
          );
          if (!carrying) {
            this.log("Skipping invalid intention", intention.predicate);
            this.removeIntention(intention);
            await new Promise((res) => setImmediate(res));
            continue;
          }
        }

        this.#currentIntention = intention;
        let keepIntentionInQueue = false;

        await intention
          .achieve()
          .then((result) => {
            this.#clearFailureStats(intention.predicate);
            return result;
          })
          .catch((error) => {
            const wasPreempted = isPreemptedIntentionError(error);
            const wasStopped = isStoppedIntentionError(error);

            if (wasPreempted) {
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
              this.#recordFailedIntention(intention.predicate);

              if (intention.predicate[0] === "go_drop_off") {
                this.#pushNextNearestDelivery(intention.predicate);
              }
            }
          })
          .finally(() => {
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
}

// ==========================================
// Entry point
// ==========================================

/*
 * Starts the BDI agent and connects updates to the internal state.
 */
export async function startBDIAgent(socket, bs, actions) {
  console.log(`[${bs.me.name ?? "BDI"}] Waiting for initial beliefs...`);

  await waitUntil(() => isReady(bs), RUNTIME.READINESS_CHECK_DELAY_MS);

  console.log(`[${bs.me.name ?? "BDI"}] Agent ready`);

  const agent = new IntentionRevisionRevise(bs, actions.executePredicate);

  // Rate-limited reconsideration. Every decay tick of every visible parcel
  // fires a sensing event; regenerating and re-sorting options on each one
  // caused continuous preemption churn. Reconsider immediately only on a
  // significant change (the set of free or carried parcels changed),
  // otherwise at most every RECONSIDERATION_MIN_INTERVAL_MS.
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
    optionsGeneration(agent, bs);

    // Re-evaluate even when the option set did not change: some scores vary
    // with time (a camp pocket going cold, decay drift), and those transitions
    // would otherwise never be acted on, since push() only re-sorts when it
    // adds a new predicate. Hysteresis in sortQueueByScore still guards against
    // churn, so this stays within the WP3 reconsideration cadence.
    agent.sortQueueByScore();
  };

  agent.loop();
}
