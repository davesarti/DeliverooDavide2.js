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
  EXPLORATION_INCENTIVE,
  DROP_DISINCENTIVE,
} from "./options.js";
import { deliveryMapDistance } from "../utils/stateUtils.js";
import { RUNTIME } from "../utils/constants.js";
import { waitUntil } from "../utils/asyncUtils.js";

// ==========================================
// Readiness check
// ==========================================

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
  #failedIntentionPool = new Map();
  #failedIntentionRetryMs = RUNTIME.FAILED_INTENTION_RETRY_MS;
  #bs;
  #executePredicate;

  constructor(bs, executePredicate) {
    this.#bs = bs;
    this.#executePredicate = executePredicate;
  }

  get intention_queue() {
    return this.#intentionQueue;
  }

  log(...args) {
    console.log(`[${this.#bs.me.name ?? "BDI"}]`, ...args);
  }

  #predicateKey(predicate) {
    return predicate.join(" ");
  }

  isPredicateInFailedPool(predicate) {
    return this.#failedIntentionPool.has(this.#predicateKey(predicate));
  }

  #recordFailedIntention(predicate) {
    const key = this.#predicateKey(predicate);
    this.#failedIntentionPool.set(key, {
      predicate: [...predicate],
      addedAtMs: Date.now(),
    });
  }

  #requeueFailedIntentions() {
    const now = Date.now();
    let requeued = false;

    for (const [key, entry] of this.#failedIntentionPool.entries()) {
      if (now - entry.addedAtMs < this.#failedIntentionRetryMs) continue;

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
        estimatedLoss += Math.min(parcel.reward, routeDist * distanceFactor());
      }
      return totalReward - estimatedLoss - DROP_DISINCENTIVE;
    }

    if (action === "go_pick_up") {
      const [, , , parcelId] = predicate;
      const newParcel = parcels.get(parcelId);
      if (!newParcel) return -1;

      const routeDist = pickupRouteDistance(newParcel, me, this.#bs);
      if (routeDist == null) return -1;

      if (myParcels.length === 0) {
        return newParcel.reward - routeDist * distanceFactor();
      }

      for (const parcel of myParcels) {
        estimatedLoss += Math.min(parcel.reward, routeDist * distanceFactor());
      }
      return totalReward + newParcel.reward - routeDist * distanceFactor() - estimatedLoss;
    }

    if (action === "explore") return EXPLORATION_INCENTIVE;

    return 0;
  }

  sortQueueByScore() {
    const running = this.#currentIntention;

    const scored = this.intention_queue.map((intention, index) => ({
      intention,
      index,
      score: this.intentionScore(intention.predicate),
    }));

    const valid = scored.filter((e) => e.score > 0);
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
      this.log("Preemption: stopping current intention");
      running.stop(STOP_REASON_PREEMPTION);
    }
  }

  createIntention(predicate) {
    return new Intention(this, predicate, this.#executePredicate);
  }

  removeIntention(intention) {
    const index = this.intention_queue.indexOf(intention);
    if (index !== -1) this.intention_queue.splice(index, 1);
  }

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

export async function startBDIAgent(socket, bs, actions) {
  console.log(`[${bs.me.name ?? "BDI"}] Waiting for initial beliefs...`);

  await waitUntil(() => isReady(bs), RUNTIME.READINESS_CHECK_DELAY_MS);

  console.log(`[${bs.me.name ?? "BDI"}] Agent ready`);

  const agent = new IntentionRevisionRevise(bs, actions.executePredicate);

  bs.onUpdate = () => optionsGeneration(agent, bs);

  agent.loop();
}