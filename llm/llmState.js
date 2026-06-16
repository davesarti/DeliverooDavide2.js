export function createLLMState() {
  return {
    // Cross-turn coordination context (the only state that must survive between
    // separate chat turns). Auto-maintained by the coordination tools.
    // `partnerParkedOn` is a best-effort hint, not ground truth: the authoritative
    // sync state is the BDI's status stream.
    //
    // Durable strategy rules now live on the belief state (bs.rules), not here.
    coordination: {
      active: false,
      partnerParkedOn: null,
      // cid of the active `wait` directive, so handleStatus can clear the
      // stale partnerParkedOn when the wait times out without a signal.
      parkedCid: null,
    },
  };
}
