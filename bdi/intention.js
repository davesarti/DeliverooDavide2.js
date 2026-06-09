import { executePredicate } from "../actions/actions.js";

// ==========================================
// Error type constants
// ==========================================

const STOPPED_INTENTION = "stopped intention";
const PREEMPTED_INTENTION = "preempted intention";
const STOPPED_PLAN = "stopped"; // throwato da executePath in actions.js

export const STOP_REASON_PREEMPTION = "preemption";

// ==========================================
// Error helpers
// ==========================================

export function createStoppedIntentionError(predicate, stopReason) {
  if (stopReason === STOP_REASON_PREEMPTION) {
    return [PREEMPTED_INTENTION, ...predicate];
  }
  return [STOPPED_INTENTION, ...predicate];
}

export function isStoppedPlanError(error) {
  return Array.isArray(error) && error[0] === STOPPED_PLAN;
}

export function isPreemptedIntentionError(error) {
  return Array.isArray(error) && error[0] === PREEMPTED_INTENTION;
}

export function isStoppedIntentionError(error) {
  return Array.isArray(error) && error[0] === STOPPED_INTENTION;
}

/*
 * Controlla se esiste già un'intenzione con lo stesso predicato nella coda.
 */
export function samePredicateInQueue(queue, predicate) {
  return queue.find((i) => i.predicate.join(" ") === predicate.join(" "));
}

// ==========================================
// Intention
// ==========================================

/*
 * Un'intenzione rappresenta l'impegno dell'agente a raggiungere un obiettivo.
 *
 * Deleghiamo tutta l'esecuzione ad `executePredicate` (actions/actions.js),
 * che incapsula pathfinding, movimenti, pickup e putdown.
 * La fermata dell'intenzione avviene tramite il callback `shouldStop`,
 * che viene interrogato internamente a ogni passo di esecuzione.
 *
 * Rispetto alla vecchia architettura non usiamo più la planLibrary:
 * il dispatch sulle azioni primitive (go_pick_up, go_drop_off, explore)
 * è già gestito in un unico posto da executePredicate.
 */
export class Intention {
  #stopped = false;
  #stopReason = null;
  #started = false;
  #parent;
  #predicate;

  constructor(parent, predicate) {
    this.#parent = parent;
    this.#predicate = predicate;
  }

  get predicate() {
    return this.#predicate;
  }

  get stopped() {
    return this.#stopped;
  }

  /*
   * Ferma l'intenzione. Se stopReason è STOP_REASON_PREEMPTION, l'intenzione
   * verrà rigenerata in coda dall'IntentionRevision invece di essere scartata.
   */
  stop(reason = null) {
    this.#stopped = true;
    this.#stopReason = reason;
  }

  log(...args) {
    if (this.#parent?.log) {
      this.#parent.log("\t", ...args);
    } else {
      console.log(...args);
    }
  }

  async achieve() {
    // Guardia contro doppio avvio (es. sub-intenzioni riciclate).
    if (this.#started) return this;
    this.#started = true;

    if (this.stopped) {
      throw createStoppedIntentionError(this.#predicate, this.#stopReason);
    }

    this.log("achieving intention", ...this.#predicate);

    try {
      const result = await executePredicate(this.#predicate, {
        shouldStop: () => this.#stopped,
      });

      this.log("successful intention", ...this.#predicate, "result:", result);
      return result;
    } catch (error) {
      // Se l'intenzione è stata fermata (preemption o stop esplicito),
      // convertiamo in un errore tipizzato che il loop sa riconoscere.
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
