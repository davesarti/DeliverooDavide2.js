// ==========================================
// Error type constants
// ==========================================

const STOPPED_INTENTION = "stopped intention";
const PREEMPTED_INTENTION = "preempted intention";
const STOPPED_PLAN = "stopped";

export const STOP_REASON_PREEMPTION = "preemption";

// ==========================================
// Error helpers
// ==========================================

/*
 * Trasforma uno stop in un errore coerente con il tipo di interruzione.
 */
export function createStoppedIntentionError(predicate, stopReason) {
  if (stopReason === STOP_REASON_PREEMPTION) {
    return [PREEMPTED_INTENTION, ...predicate];
  }
  return [STOPPED_INTENTION, ...predicate];
}

/*
 * Riconosce un errore che blocca l'intero piano.
 */
export function isStoppedPlanError(error) {
  return Array.isArray(error) && error[0] === STOPPED_PLAN;
}

/*
 * Riconosce un'intenzione interrotta da una preemption.
 */
export function isPreemptedIntentionError(error) {
  return Array.isArray(error) && error[0] === PREEMPTED_INTENTION;
}

/*
 * Riconosce un'intenzione fermata volontariamente.
 */
export function isStoppedIntentionError(error) {
  return Array.isArray(error) && error[0] === STOPPED_INTENTION;
}

/*
 * Evita di inserire due volte lo stesso predicato in coda.
 */
export function samePredicateInQueue(queue, predicate) {
  return queue.find((i) => i.predicate.join(" ") === predicate.join(" "));
}

// ==========================================
// Intention
// ==========================================

export class Intention {
  #stopped = false;
  #stopReason = null;
  #started = false;
  #parent;
  #predicate;
  #executePredicate;

  /*
   * Crea una nuova intenzione pronta da eseguire.
   */
  constructor(parent, predicate, executePredicate) {
    this.#parent = parent;
    this.#predicate = predicate;
    this.#executePredicate = executePredicate;
  }

  /*
   * Restituisce il predicato assegnato a questa intenzione.
   */
  get predicate() {
    return this.#predicate;
  }

  /*
   * Indica se l'intenzione è stata fermata.
   */
  get stopped() {
    return this.#stopped;
  }

  /*
   * Marca l'intenzione come fermata e salva il motivo.
   */
  stop(reason = null) {
    this.#stopped = true;
    this.#stopReason = reason;
  }

  /*
   * Scrive i log passando dal logger del padre, se c'è.
   */
  log(...args) {
    if (this.#parent?.log) {
      this.#parent.log("\t", ...args);
    } else {
      console.log(...args);
    }
  }

  /*
   * Esegue il predicato e gestisce stop, successi e fallimenti.
   */
  async achieve() {
    if (this.#started) return this;
    this.#started = true;

    if (this.stopped) {
      throw createStoppedIntentionError(this.#predicate, this.#stopReason);
    }

    this.log("achieving intention", ...this.#predicate);

    try {
      const result = await this.#executePredicate(this.#predicate, {
        shouldStop: () => this.#stopped,
      });

      this.log("successful intention", ...this.#predicate, "result:", result);
      return result;
    } catch (error) {
      if (this.#stopped || isStoppedPlanError(error)) {
        const stopError = createStoppedIntentionError(
          this.#predicate,
          this.#stopReason
        );
        this.log(stopError[0], ...this.#predicate);
        throw stopError;
      }

      this.log("failed intention", ...this.#predicate, "error:", error);
      throw error;
    }
  }
}