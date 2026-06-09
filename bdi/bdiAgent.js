import { beliefState } from "../beliefs/beliefState.js";
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

function isReady() {
  return (
    beliefState.me.id != null &&
    beliefState.me.x != null &&
    beliefState.me.y != null &&
    Array.isArray(beliefState.map.deliveryDistanceMap) &&
    beliefState.map.deliveryDistanceMap.length > 0
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

  get intention_queue() {
    return this.#intentionQueue;
  }

  log(...args) {
    console.log(...args);
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

  /*
   * Reintroduce in coda le intenzioni fallite il cui timeout di retry è scaduto.
   */
  #requeueFailedIntentions() {
    const now = Date.now();
    let requeued = false;

    for (const [key, entry] of this.#failedIntentionPool.entries()) {
      if (now - entry.addedAtMs < this.#failedIntentionRetryMs) continue;

      this.#failedIntentionPool.delete(key);

      // Non reinserire se è l'intenzione attualmente in esecuzione.
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
   * Score di un predicato rispetto allo stato corrente del beliefState.
   * Usato per ordinare la coda e decidere se preemptare l'intenzione corrente.
   */
  intentionScore(predicate) {
    const me = beliefState.me;
    const parcels = beliefState.parcels;
    const deliveryDistanceMap = beliefState.map.deliveryDistanceMap;

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

      const routeDist = pickupRouteDistance(newParcel, me);
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

  /*
   * Riordina la coda per score decrescente e, se necessario, preempta
   * l'intenzione corrente a favore di una più conveniente.
   */
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

    this.log(
      "Queue sorted by score",
      valid.map((e) => ({
        predicate: e.intention.predicate,
        score: e.score,
      }))
    );

    const best = this.intention_queue[0];
    if (running && best && running !== best) {
      this.log(
        "Preemption: stopping the current job and loading the higher-score one"
      );
      running.stop(STOP_REASON_PREEMPTION);
    }
  }

  createIntention(predicate) {
    return new Intention(this, predicate);
  }

  removeIntention(intention) {
    const index = this.intention_queue.indexOf(intention);
    if (index !== -1) this.intention_queue.splice(index, 1);
  }

  /*
   * Loop principale del BDI agent.
   * A ogni ciclo: controlla retry dei fallimenti, valida l'intenzione in testa,
   * la esegue e gestisce i vari esiti (successo, preemption, stop, fallimento).
   */
  async loop() {
    while (true) {
      this.#requeueFailedIntentions();

      if (this.intention_queue.length > 0) {
        const intention = this.intention_queue[0];
        const [action] = intention.predicate;

        // Validazione preventiva: scarta intenzioni già non più perseguibili.
        if (action === "go_pick_up") {
          const parcelId = intention.predicate[3];
          const parcel = beliefState.parcels.get(parcelId);
          if (!parcel || parcel.carriedBy) {
            console.log(
              "Skipping intention because it is no longer valid",
              intention.predicate
            );
            this.removeIntention(intention);
            await new Promise((res) => setImmediate(res));
            continue;
          }
        }

        if (action === "go_drop_off") {
          const carrying = Array.from(beliefState.parcels.values()).some(
            (p) => p.carriedBy === beliefState.me.id
          );
          if (!carrying) {
            console.log(
              "Skipping intention because it is no longer valid",
              intention.predicate
            );
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
              // L'intenzione era stata preemptata: la rigeneriamo in coda
              // così potrà essere ripresa se tornerà ad avere lo score più alto.
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
              // Fallimento genuino: blocca il predicato per FAILED_INTENTION_RETRY_MS.
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
        // Coda vuota: esplora.
        this.push(["explore"]);
      }

      await new Promise((res) => setImmediate(res));
    }
  }
}

// ==========================================
// IntentionRevisionRevise (strategia di push)
// ==========================================

/*
 * Variante del revision agent che, ad ogni push, ri-ordina immediatamente
 * la coda per score e può preemptare l'intenzione corrente se ne arriva una
 * più conveniente.
 */
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

/*
 * Inizializza l'agente BDI e avvia il suo loop.
 * Attende che il beliefState sia pronto (mappa + identità ricevute),
 * poi aggancia optionsGeneration su beliefState.onUpdate in modo che
 * ogni nuovo sensing produca automaticamente nuove opzioni.
 *
 * Da chiamare da index.js quando AGENT_CONFIG.mode === "BDI".
 */
export async function startBDIAgent() {
  console.log("[BDI] Waiting for initial beliefs...");

  await waitUntil(isReady, RUNTIME.READINESS_CHECK_DELAY_MS);

  console.log("[BDI] Agent ready");

  const agent = new IntentionRevisionRevise();

  // Ogni volta che onSensing aggiorna il beliefState, rigenera le opzioni.
  beliefState.onUpdate = () => optionsGeneration(agent);

  agent.loop();
}
