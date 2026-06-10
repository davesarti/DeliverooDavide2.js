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

  constructor(parent, predicate, executePredicate) {
    this.#parent = parent;
    this.#predicate = predicate;
    this.#executePredicate = executePredicate;
  }

  get predicate() {
    return this.#predicate;
  }

  get stopped() {
    return this.#stopped;
  }

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