/*
 * planExecutor.js
 *
 * Executes a PDDL plan produced by pddlPlanner against the real game by
 * translating each plan step into a call on the agent's `actions` object
 * (created by actions/actions.js: { move, pickup, putdown, ... }).
 *
 * Mapping (PDDL action name -> game action):
 *   move-up / push-up       -> actions.move("up")
 *   move-down / push-down   -> actions.move("down")
 *   move-left / push-left   -> actions.move("left")
 *   move-right / push-right -> actions.move("right")
 *   pickup                  -> actions.pickup()
 *   putdown                 -> actions.putdown()
 *
 * Why push-* and move-* collapse to the same call:
 *   The Deliveroo server has no separate "push" command. Pushing a crate is
 *   done by moving INTO it: Controller.move() detects a crate on the target
 *   tile and, if the tile beyond is a type-5 unlocked tile, slides the crate
 *   over and lets the agent step in. So at runtime a push is just a move in
 *   the same direction.
 *
 * The solver lowercases action names, so the lookup table is keyed in
 * lowercase and matched case-insensitively.
 */

// ==========================================
// Direction lookup
// ==========================================

/*
 * Maps every PDDL action name to a game-level direction, or to a special
 * token ("pickup" / "putdown") handled separately.
 */
const ACTION_MAP = {
  "move-up": { kind: "move", direction: "up" },
  "move-down": { kind: "move", direction: "down" },
  "move-left": { kind: "move", direction: "left" },
  "move-right": { kind: "move", direction: "right" },

  "push-up": { kind: "move", direction: "up" },
  "push-down": { kind: "move", direction: "down" },
  "push-left": { kind: "move", direction: "left" },
  "push-right": { kind: "move", direction: "right" },

  pickup: { kind: "pickup" },
  putdown: { kind: "putdown" },
};

// ==========================================
// Execution
// ==========================================

/*
 * Executes a plan step by step.
 *
 * @param {Array}  plan        - steps from pddlPlanner: { action, args, ... }
 * @param {object} actions     - the agent actions object (move/pickup/putdown)
 * @param {object} [opts]
 * @param {() => boolean} [opts.isStopped] - polled before each step so an
 *        external controller (BDI intention / LLM loop) can abort cleanly.
 *
 * @returns {Promise<boolean>} true if the whole plan executed; throws if a
 *        step fails in a way the caller should handle (e.g. a blocked move
 *        that survived retries), so the caller can replan.
 *
 * Behaviour on a blocked move:
 *   actions.move throws an error tagged `movementBlocked` when the server
 *   refuses the move (a crossing agent, or a crate that can't be pushed).
 *   We let that error propagate: the world has changed since planning, so the
 *   right response is to replan from the new state, not to retry blindly.
 */
export async function executePlan(plan, actions, opts = {}) {
  const isStopped = opts.isStopped || (() => false);

  if (!plan || plan.length === 0) {
    return true;
  }

  for (const step of plan) {
    if (isStopped()) {
      throw new Error("PDDL plan execution stopped");
    }

    const mapped = ACTION_MAP[step.action.toLowerCase()];

    if (!mapped) {
      // An action in the plan that we don't know how to execute. This should
      // never happen if domain.pddl and ACTION_MAP stay in sync; surface it
      // loudly rather than silently skipping, since skipping would desync the
      // plan from the world.
      throw new Error(`No executor for PDDL action "${step.action}"`);
    }

    switch (mapped.kind) {
      case "move":
        await actions.move(mapped.direction);
        break;
      case "pickup":
        await actions.pickup();
        break;
      case "putdown":
        await actions.putdown();
        break;
    }
  }

  return true;
}

/*
 * Exposed for testing and for the report (lets you print the translated
 * sequence without running it).
 */
export function translatePlan(plan) {
  return (plan || []).map((step) => {
    const mapped = ACTION_MAP[step.action.toLowerCase()];
    if (!mapped) return { step: step.action, call: "UNKNOWN" };
    if (mapped.kind === "move") return { step: step.action, call: `move("${mapped.direction}")` };
    return { step: step.action, call: `${mapped.kind}()` };
  });
}