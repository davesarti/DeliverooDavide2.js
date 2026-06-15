import { makeDirective, makeSignal } from "../utils/coordProtocol.js";
import { COORD_LLM_WAIT_TIMEOUT_MS } from "../utils/constants.js";

/*
 * LLM-side coordination: sends directives/signals to the BDI partner and lets
 * the executor await a directive's status (matched by cid). Statuses that arrive
 * before the executor waits are buffered so the wait still resolves.
 */
export function createCoordinator(socket, bs, llmState) {
  let cidCounter = 0;
  const pendingWaiters = new Map(); // cid -> resolve(statusMsg)
  const bufferedStatuses = new Map(); // cid -> statusMsg

  /*
   * Called by the agent's onMsg router for every incoming coord status.
   */
  function handleStatus(msg) {
    const waiter = pendingWaiters.get(msg.cid);
    if (waiter) {
      pendingWaiters.delete(msg.cid);
      waiter(msg);
    } else {
      bufferedStatuses.set(msg.cid, msg);
    }
  }

  /*
   * Sends one directive; returns { cid, delivered }. Auto-maintains the
   * cross-turn coordination context.
   */
  async function directPartner(command, args = {}) {
    const cid = ++cidCounter;
    const partnerId = bs.partner?.id;

    if (partnerId == null) {
      return { cid, delivered: false };
    }

    const status = await socket.emitSay(partnerId, makeDirective(cid, command, args));

    if (command === "resume") {
      llmState.coordination.active = false;
      llmState.coordination.partnerParkedOn = null;
    } else {
      llmState.coordination.active = true;
      if (command === "wait") {
        llmState.coordination.partnerParkedOn = args.signal ?? null;
      }
    }

    return { cid, delivered: status === "successful" };
  }

  /*
   * Sends an out-of-band signal to release the BDI's current wait.
   */
  async function signalPartner(signal) {
    const partnerId = bs.partner?.id;
    if (partnerId == null) return { delivered: false };

    const status = await socket.emitSay(partnerId, makeSignal(signal));
    llmState.coordination.partnerParkedOn = null;
    return { delivered: status === "successful" };
  }

  /*
   * Resolves with the status for `cid` (a {cid, ok, detail?} object), or a
   * synthetic timeout status if none arrives in time.
   */
  function waitForPartner(cid, timeoutMs = COORD_LLM_WAIT_TIMEOUT_MS) {
    if (bufferedStatuses.has(cid)) {
      const status = bufferedStatuses.get(cid);
      bufferedStatuses.delete(cid);
      return Promise.resolve(status);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingWaiters.delete(cid);
        resolve({ cid, ok: false, detail: "timeout waiting for partner" });
      }, timeoutMs);

      pendingWaiters.set(cid, (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });
  }

  return { handleStatus, directPartner, signalPartner, waitForPartner };
}
