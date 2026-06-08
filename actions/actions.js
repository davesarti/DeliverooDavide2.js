import { socket } from "../socket.js";
import { AGENT_CONFIG } from "../config.js";
import { beliefState } from "../beliefs/beliefState.js";
import { findPath } from "../pathfinding/pathfinding.js";
import { GO_TO_TIMEOUT_MS } from "../utils/constants.js";
import { findCellsToExplore } from "../utils/mapUtils.js";

function sleepImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

/*
 * Esegue un singolo movimento sul server e aggiorna subito la posizione locale.
 */
export async function move(direction) {
  const moved = await socket.emitMove(direction);

  if (!moved) {
    throw new Error(`Movement failed: ${direction}`);
  }

  beliefState.me.x = moved.x;
  beliefState.me.y = moved.y;

  return moved;
}

/*
 * Prova a raccogliere i pacchi presenti sulla cella corrente.
 */
export async function pickup() {
  return await socket.emitPickup();
}

/*
 * Prova a consegnare i pacchi sulla cella corrente.
 */
export async function putdown() {
  return await socket.emitPutdown();
}

/*
 * Esegue una sequenza di mosse già calcolata dal pathfinding.
 */
export async function executePath(
  path,
  {
    shouldStop = () => false,
    onStep = null,
    timeoutMs = GO_TO_TIMEOUT_MS,
  } = {}
) {
  const startedAt = Date.now();

  for (const direction of path) {
    if (shouldStop()) throw ["stopped"];

    if (timeoutMs != null && Date.now() - startedAt > timeoutMs) {
      throw new Error("go_to timeout");
    }

    await move(direction);

    if (onStep) {
      await onStep();
    }

    if (shouldStop()) throw ["stopped"];

    await sleepImmediate();
  }

  return true;
}

/*
 * Calcola un percorso verso una cella e lo esegue.
 * L'algoritmo usato viene scelto da config.js.
 */
export async function goTo(
  x,
  y,
  {
    shouldStop = () => false,
    timeoutMs = GO_TO_TIMEOUT_MS,
  } = {}
) {
  const result = findPath(
    beliefState.me,
    { x, y },
    AGENT_CONFIG.pathfinding.algorithm
  );

  if (!result || !Array.isArray(result.path)) {
    throw new Error(`Path not found to (${x}, ${y})`);
  }

  return await executePath(result.path, {
    shouldStop,
    timeoutMs,
  });
}

/*
 * Va sulla posizione indicata e poi prova a raccogliere.
 * parcelId è tenuto per validazioni/debug, anche se il server raccoglie per cella.
 */
export async function goPickUp(
  x,
  y,
  parcelId = null,
  {
    shouldStop = () => false,
  } = {}
) {
  await goTo(x, y, { shouldStop });

  if (shouldStop()) throw ["stopped"];

  return await pickup();
}

/*
 * Va sulla delivery indicata e poi prova a consegnare.
 */
export async function goDropOff(
  x,
  y,
  {
    shouldStop = () => false,
  } = {}
) {
  await goTo(x, y, { shouldStop });

  if (shouldStop()) throw ["stopped"];

  return await putdown();
}

/*
 * Esplora una spawn tile non occupata dalla posizione corrente.
 */
export async function explore({
  shouldStop = () => false,
} = {}) {
  const candidates = findCellsToExplore(
    beliefState.map.spawnTiles,
    beliefState.me
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
 * Traduce una vecchia predicate BDI in una chiamata alle azioni comuni.
 */
export async function executePredicate(
  predicate,
  {
    shouldStop = () => false,
  } = {}
) {
  const [action, x, y, id] = predicate;

  if (action === "go_to") {
    return await goTo(x, y, { shouldStop });
  }

  if (action === "go_pick_up") {
    return await goPickUp(x, y, id, { shouldStop });
  }

  if (action === "go_drop_off") {
    return await goDropOff(x, y, { shouldStop });
  }

  if (action === "explore") {
    return await explore({ shouldStop });
  }

  throw new Error(`Unknown predicate: ${predicate.join(" ")}`);
}