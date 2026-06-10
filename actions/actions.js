import { findPath } from "../pathfinding/pathfinding.js";
import { AGENT_CONFIG, } from "../config.js";
import { RUNTIME } from "../utils/constants.js";
import { yieldControl } from "../utils/asyncUtils.js";
import { findCellsToExplore } from "../utils/mapUtils.js";

/*
 * Crea il layer di azioni per un agente specifico.
 * Riceve socket e beliefState dell'agente invece di importarli come singleton.
 * Ritorna un oggetto con tutte le funzioni di azione disponibili.
 */
/*
 * Espone le azioni operative dell'agente sopra al socket di gioco.
 */
export function createActions(socket, bs) {

  /*
   * Muove l'agente in una direzione e aggiorna la posizione locale.
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
   * Chiede al server di raccogliere il pacco sulla cella corrente.
   */
  async function pickup() {
    return await socket.emitPickup();
  }

  /*
   * Rilascia il pacco trasportato sulla cella corrente.
   */
  async function putdown() {
    return await socket.emitPutdown();
  }

  /*
   * Esegue un percorso passo per passo, con stop e timeout.
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
   * Raggiunge una posizione della mappa usando il pathfinding attivo.
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
      bs
    );

    if (!result || !Array.isArray(result.path)) {
      throw new Error(`Path not found to (${x}, ${y})`);
    }

    return await executePath(result.path, { shouldStop, timeoutMs });
  }

  /*
   * Va sul pacco e prova a raccoglierlo.
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
   * Va su una delivery tile e deposita i pacchi trasportati.
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
   * Prova a esplorare una spawn tile non troppo recente.
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
   * Traduce un predicato pianificato nell'azione concreta da eseguire.
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