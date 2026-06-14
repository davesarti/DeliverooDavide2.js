/*
 * pddlPlanner.js
 *
 * Thin wrapper around the online PDDL solver.
 *
 * Reads the static domain file once (cached), builds a problem from the
 * belief state + goal via problemBuilder, and asks the online solver for a
 * plan. Returns the plan as the array of steps produced by the solver:
 *
 *   [ { parallel: false, action: "move-right", args: ["t_1_1", "t_2_1"] }, ... ]
 *
 * or null when no plan exists / the solver fails.
 */

import { onlineSolver } from "@unitn-asa/pddl-client";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { buildProblem } from "./problemBuilder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==========================================
// Domain caching
// ==========================================

let cachedDomain = null;

/*
 * Reads pddl/domain.pddl (next to this file) once and caches it. The domain
 * is static, so re-reading on every plan would be wasteful.
 */
function loadDomain() {
  if (cachedDomain === null) {
    const domainPath = path.join(__dirname, "domain.pddl");
    cachedDomain = fs.readFileSync(domainPath, "utf8");
  }
  return cachedDomain;
}

// ==========================================
// Planning
// ==========================================

/*
 * Computes a plan for the given goal from the current belief state.
 *
 * @param {object} bs   - belief state
 * @param {object} goal - goal descriptor (see problemBuilder.js header)
 * @returns {Promise<Array|null>} plan steps, or null if no plan was found
 *
 * Throws are caught and converted to a null result so the caller (a BDI plan
 * or an LLM tool) can treat "no plan" and "solver error" uniformly: both mean
 * "this approach didn't produce a plan, fall back".
 */
export async function plan(bs, goal) {
  const domain = loadDomain();
  const problem = buildProblem(bs, goal);

  try {
    const result = await onlineSolver(domain, problem);

    // onlineSolver returns undefined when no plan is found.
    if (!result || result.length === 0) {
      return null;
    }

    return result;
  } catch (err) {
    console.warn("[pddlPlanner] solver error:", err.message);
    return null;
  }
}

/*
 * Convenience: returns the generated problem string without solving.
 * Useful for debugging, offline tests, and the report.
 */
export function buildProblemString(bs, goal) {
  return buildProblem(bs, goal);
}

/*
 * Convenience: returns the cached domain string. Exposed for offline tests
 * that want to call onlineSolver directly with a hand-written problem.
 */
export function getDomain() {
  return loadDomain();
}