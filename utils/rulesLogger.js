/*
 * Periodic diagnostic logger for the belief-state ruleset (bs.rules). Prints the
 * structured rules every `intervalMs` for each registered belief state, reusing
 * serializeRules so the Maps are flattened into a plain, JSON-friendly shape.
 * Purely observational — it never mutates the belief state.
 */
import { serializeRules } from "./rulesSync.js";

const DEFAULT_INTERVAL_MS = 5000;

/*
 * Starts a single interval that logs the rules structure of every belief state
 * in `beliefStates`. Returns the timer handle so callers can clear it. The
 * interval is unref'd so it never keeps the process alive on its own.
 */
export function startRulesLogger(beliefStates, intervalMs = DEFAULT_INTERVAL_MS) {
  const timer = setInterval(() => {
    for (const bs of beliefStates) {
      const label = bs.me.name ?? bs.me.id ?? "agent";
      console.log(
        `[${label}] Rules: ${JSON.stringify(serializeRules(bs.rules))}`
      );
    }
  }, intervalMs);

  timer.unref?.();
  return timer;
}
