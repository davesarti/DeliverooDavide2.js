import { makeDirective, makeSignal, makeRulesUpdate } from "../utils/coordProtocol.js";
import { serializeRules } from "../utils/rulesSync.js";
import { COORD_LLM_WAIT_TIMEOUT_MS } from "../utils/constants.js";

/*
 * LLM-side coordination: sends directives/signals to the BDI partner and lets
 * the executor await a directive's status (matched by cid). Statuses that arrive
 * before the executor waits are buffered so the wait still resolves.
 */
export function createCoordinator(socket, bs, llmState) {
  let cidCounter = 0;
  const pendingWaiters = new Map(); // cid -> resolve(statusMsg)
  const bufferedStatuses = new Map(); // cid -> { msg, bufferedAtMs }

  /*
   * Drops buffered statuses nobody has claimed within COORD_LLM_WAIT_TIMEOUT_MS
   * of arriving. A status is buffered here when it lands before the LLM calls
   * wait_for_partner for that cid (see handleStatus); a fire-and-forget
   * direct_partner call whose result is never awaited leaves one behind
   * forever otherwise. Reuses the same timeout that already governs how long
   * an active wait_for_partner will wait, since the logic is symmetric: if a
   * wait would give up after this long with no status, a status is just as
   * safe to give up on after this long with no one asking for it. Piggybacks
   * on the two call sites that already touch this map instead of a new timer.
   */
  function evictExpiredBuffered() {
    const now = Date.now();
    for (const [cid, entry] of bufferedStatuses) {
      if (now - entry.bufferedAtMs > COORD_LLM_WAIT_TIMEOUT_MS) {
        bufferedStatuses.delete(cid);
      }
    }
  }

  /*
   * Called by the agent's onMsg router for every incoming coord status.
   */
  function handleStatus(msg) {
    evictExpiredBuffered();

    const waiter = pendingWaiters.get(msg.cid);
    if (waiter) {
      // Someone called wait_for_partner for this cid — deliver it normally.
      pendingWaiters.delete(msg.cid);
      if (llmState.coordination.parkedCid === msg.cid) {
        llmState.coordination.partnerParkedOn = null;
        llmState.coordination.parkedCid = null;
      }
      waiter(msg);
      return;
    }

    // No waiter. If this is the status for a `wait` directive (partner's
    // waitForSignal timed out), clear the now-stale partnerParkedOn rather
    // than buffering a status nobody will ever read.
    if (llmState.coordination.parkedCid != null && msg.cid === llmState.coordination.parkedCid) {
      llmState.coordination.partnerParkedOn = null;
      llmState.coordination.parkedCid = null;
      return;
    }

    bufferedStatuses.set(msg.cid, { msg, bufferedAtMs: Date.now() });
  }

  /*
   * Sends one directive; returns { cid, delivered }. Auto-maintains the
   * cross-turn coordination context.
   */
  async function directPartner(command, args = {}) {
    evictExpiredBuffered();

    const cid = ++cidCounter;
    const partnerId = bs.partner?.id;

    if (partnerId == null) {
      return { cid, delivered: false };
    }

    const status = await socket.emitSay(partnerId, makeDirective(cid, command, args));

    if (command === "resume") {
      llmState.coordination.active = false;
      llmState.coordination.partnerParkedOn = null;
      llmState.coordination.parkedCid = null;
    } else {
      llmState.coordination.active = true;
      if (command === "wait") {
        llmState.coordination.partnerParkedOn = args.signal ?? null;
        llmState.coordination.parkedCid = cid;
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
    llmState.coordination.parkedCid = null;
    return { delivered: status === "successful" };
  }

  /*
   * Resolves with the status for `cid` (a {cid, ok, detail?} object), or a
   * synthetic timeout status if none arrives in time.
   */
  function waitForPartner(cid, timeoutMs = COORD_LLM_WAIT_TIMEOUT_MS) {
    if (bufferedStatuses.has(cid)) {
      const { msg } = bufferedStatuses.get(cid);
      bufferedStatuses.delete(cid);
      return Promise.resolve(msg);
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

  /*
   * Pushes the current ruleset to the BDI-only partner so it mirrors the rules
   * the LLM has set. Fire-and-forget; a no-op (delivered:false) when there is
   * no partner, e.g. LLM-only mode.
   */
  async function syncRules() {
    const partnerId = bs.partner?.id;
    if (partnerId == null) return { delivered: false };

    const status = await socket.emitSay(
      partnerId,
      makeRulesUpdate(serializeRules(bs.rules))
    );
    return { delivered: status === "successful" };
  }

  return { handleStatus, directPartner, signalPartner, waitForPartner, syncRules };
}
