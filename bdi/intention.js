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
 * Transforms a stop into an error consistent with the type of interruption.
 */
export function createStoppedIntentionError(predicate, stopReason) {
  if (stopReason === STOP_REASON_PREEMPTION) {
    return [PREEMPTED_INTENTION, ...predicate];
  }
  return [STOPPED_INTENTION, ...predicate];
}

/*
 * Recognizes an error that blocks the entire plan.
 */
export function isStoppedPlanError(error) {
  return Array.isArray(error) && error[0] === STOPPED_PLAN;
}

/*
 * Recognizes an intention interrupted by a preemption.
 */
export function isPreemptedIntentionError(error) {
  return Array.isArray(error) && error[0] === PREEMPTED_INTENTION;
}

/*
 * Recognizes an intention stopped voluntarily.
 */
export function isStoppedIntentionError(error) {
  return Array.isArray(error) && error[0] === STOPPED_INTENTION;
}

/*
 * Prevents inserting the same predicate twice in the queue.
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
   * Creates a new intention ready to execute.
   */
  constructor(parent, predicate, executePredicate) {
    this.#parent = parent;
    this.#predicate = predicate;
    this.#executePredicate = executePredicate;
  }

  /*
   * Returns the predicate assigned to this intention.
   */
  get predicate() {
    return this.#predicate;
  }

  /*
   * Indicates whether the intention has been stopped.
   */
  get stopped() {
    return this.#stopped;
  }

  /*
   * Marks the intention as stopped and saves the reason.
   */
  stop(reason = null) {
    this.#stopped = true;
    this.#stopReason = reason;
  }

  /*
   * Writes logs through the parent's logger, if available.
   */
  log(...args) {
    if (this.#parent?.log) {
      this.#parent.log("\t", ...args);
    } else {
      console.log(...args);
    }
  }

  /*
   * Executes the predicate and handles stops, successes, and failures.
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