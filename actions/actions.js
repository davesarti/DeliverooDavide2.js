import { findPath } from "../pathfinding/pathfinding.js";
import { AGENT_CONFIG, } from "../config.js";
import { RUNTIME } from "../utils/constants.js";
import { yieldControl } from "../utils/asyncUtils.js";
import { findCellsToExplore } from "../utils/mapUtils.js";

/*
 * Creates the action layer for a specific agent.
 * Receives socket and beliefState of the agent instead of importing them as singletons.
 * Returns an object with all available action functions.
 */
/*
 * Exposes the agent's operational actions above the game socket.
 */
export function createActions(socket, bs, options = {}) {
  function getBlockedTiles() {
    return options.blockedTiles ?? new Set();
  }

  /*
   * Moves the agent in a direction and updates the local position.
   */
  async function move(direction) {
    const moved = await socket.emitMove(direction);

    if (!moved) {
      throw new Error(`Movement failed: ${direction}`);
    }

    bs.me.x = moved.x;
    bs.me.y = moved.y;

    return moved;
  }

  /*
   * Asks the server to pick up the parcel on the current cell.
   */
  async function pickup() {
    return await socket.emitPickup();
  }

  /*
   * Releases the carried parcel on the current cell.
   */
  async function putdown() {
    return await socket.emitPutdown();
  }

  /*
   * Executes a path step by step, with stop and timeout.
   */
  async function executePath(
    path,
    {
      shouldStop = () => false,
      onStep = null,
      timeoutMs = RUNTIME.GO_TO_TIMEOUT_MS,
    } = {}
  ) {
    const startedAt = Date.now();

    for (const direction of path) {
      if (shouldStop()) throw ["stopped"];

      if (timeoutMs != null && Date.now() - startedAt > timeoutMs) {
        throw new Error("go_to timeout");
      }

      await move(direction);

      if (onStep) await onStep();

      if (shouldStop()) throw ["stopped"];

      await yieldControl();
    }

    return true;
  }

  /*
   * Reaches a map position using the active pathfinding.
   */
  async function goTo(
    x,
    y,
    {
      shouldStop = () => false,
      timeoutMs = RUNTIME.GO_TO_TIMEOUT_MS,
    } = {}
  ) {
    const result = findPath(
      bs.me,
      { x, y },
      AGENT_CONFIG.pathfinding.algorithm,
      bs,
      { blockedTiles: getBlockedTiles() }
    );

    if (!result || !Array.isArray(result.path)) {
      throw new Error(`Path not found to (${x}, ${y})`);
    }

    return await executePath(result.path, { shouldStop, timeoutMs });
  }

  /*
   * Goes to the parcel and tries to pick it up.
   */
  async function goPickUp(
    x,
    y,
    parcelId = null,
    { shouldStop = () => false } = {}
  ) {
    await goTo(x, y, { shouldStop });
    if (shouldStop()) throw ["stopped"];
    return await pickup();
  }

  /*
   * Goes to a delivery tile and deposits the carried parcels.
   */
  async function goDropOff(
    x,
    y,
    { shouldStop = () => false } = {}
  ) {
    await goTo(x, y, { shouldStop });
    if (shouldStop()) throw ["stopped"];
    return await putdown();
  }

  /*
   * Tries to explore a not-too-recently-visited spawn tile.
   */
  async function explore({ shouldStop = () => false } = {}) {
    const candidates = findCellsToExplore(
      bs.map.spawnTiles,
      bs.me
    );

    if (!candidates || candidates.length === 0) {
      throw new Error("No spawn tiles available");
    }

    for (const cell of candidates) {
      try {
        await goTo(cell.x, cell.y, { shouldStop });
        return true;
      } catch (error) {
        if (Array.isArray(error) && error[0] === "stopped") {
          throw error;
        }
        continue;
      }
    }

    throw new Error("No reachable spawn tile");
  }

  /*
   * Translates a planned predicate into the concrete action to execute.
   */
  async function executePredicate(
    predicate,
    { shouldStop = () => false } = {}
  ) {
    const [action, x, y, id] = predicate;

    if (action === "go_to") return await goTo(x, y, { shouldStop });
    if (action === "go_pick_up") return await goPickUp(x, y, id, { shouldStop });
    if (action === "go_drop_off") return await goDropOff(x, y, { shouldStop });
    if (action === "explore") return await explore({ shouldStop });

    throw new Error(`Unknown predicate: ${predicate.join(" ")}`);
  }

  return {
    move,
    pickup,
    putdown,
    executePath,
    goTo,
    goPickUp,
    goDropOff,
    explore,
    executePredicate,
  };
}