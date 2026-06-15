/*
 * Shared wire protocol for BDI <-> LLM coordination messages. Both agents send
 * and receive these as plain objects over the SDK `say` channel (which carries
 * `any`, so no JSON.stringify/parse is needed).
 */

export const COORD_PROTO = "coord";

/*
 * True when `msg` is a coordination message (and not operator chat / noise).
 */
export function isCoordMessage(msg) {
  return (
    msg != null &&
    typeof msg === "object" &&
    msg.proto === COORD_PROTO &&
    typeof msg.type === "string"
  );
}

/*
 * LLM -> BDI: a command to execute. `cid` correlates the later status reply.
 */
export function makeDirective(cid, command, args = {}) {
  return { proto: COORD_PROTO, type: "directive", cid, command, args };
}

/*
 * LLM -> BDI: out-of-band release of the BDI's current `wait`.
 */
export function makeSignal(signal) {
  return { proto: COORD_PROTO, type: "signal", signal };
}

/*
 * BDI -> LLM: outcome of one directive, matched back by `cid`.
 */
export function makeStatus(cid, ok, detail) {
  const msg = { proto: COORD_PROTO, type: "status", cid, ok: !!ok };
  if (detail != null) msg.detail = detail;
  return msg;
}
