import { isCoordMessage, makeStatus } from "../utils/coordProtocol.js";

/*
 * Gives the BDI agent its first message listener: it accepts coordination
 * messages from the partner (the LLM agent), feeds directives into the
 * coordination queue, releases waits on signals, and attaches a sendStatus
 * helper the agent loop uses to reply.
 */
export function setupBdiCoordination(socket, bs, agent) {
  const log = (...a) => console.log(`[${bs.me.name ?? "BDI"}] [coord]`, ...a);

  bs.coordination.sendStatus = ({ cid, ok, detail }) => {
    const partnerId = bs.partner?.id;
    if (partnerId == null) return;
    // Refresh the idle TTL so long-running directives don't trigger auto-resume
    // the moment they complete. The TTL is now measured from when the last
    // status was sent, not from when the directive arrived.
    bs.coordination.lastActivityMs = Date.now();
    Promise.resolve(socket.emitSay(partnerId, makeStatus(cid, ok, detail))).catch(
      () => {}
    );
  };

  socket.onMsg((id, name, msg) => {
    if (!isCoordMessage(msg)) return;
    if (!bs.partner || id !== bs.partner.id) return;

    bs.coordination.lastActivityMs = Date.now();

    if (msg.type === "directive") {
      bs.coordination.queue.push({
        cid: msg.cid,
        command: msg.command,
        args: msg.args ?? {},
      });
      bs.coordination.active = true;
      log(`directive #${msg.cid} ${msg.command} ${JSON.stringify(msg.args ?? {})}`);
      agent.preemptForCoordination();
    } else if (msg.type === "signal") {
      log(`signal '${msg.signal}'`);
      bs.coordination.waiting = false;
    }
  });
}
