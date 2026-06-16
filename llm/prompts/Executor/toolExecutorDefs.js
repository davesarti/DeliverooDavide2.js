const param = (description) => ({ type: "string", description });
const intParam = (description) => ({ type: "integer", description });
const numParam = (description) => ({ type: "number", description });

const thought = param(
  "Brief: what the state shows, what's still needed, why this tool. Observed facts only."
);

// Control-flow flag for terminal tools (durable-rule stores, navigation
// constraints, collect_and_deliver). These normally END the mission on success
// in a single round-trip. Set `more: true` ONLY when the SAME mission still has
// another clause to carry out after this tool (a compound "do X AND do Y"
// request) — then the loop does NOT end and asks for the next tool. Omitting it
// keeps the one-call fast path for the common single-clause mission.
const more = {
  type: "boolean",
  description:
    "Set true only if a compound mission has another clause to handle after this " +
    "tool; omit for a single-clause mission so it ends in one round-trip.",
};

function def(name, description, properties, required = ["thought"]) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        required,
        additionalProperties: false,
        properties,
      },
    },
  };
}

export const SYSTEM_EXECUTOR_TOOLS = [
  // ==========================================
  // Information tools
  // ==========================================

  def(
    "observe_environment",
    "Observe the current game state: your position, carried parcels, visible parcels, delivery tiles, and active rules.",
    { thought }
  ),

  def(
    "calculate",
    "Evaluate one arithmetic expression.",
    {
      thought,
      expression: param("One expression, e.g. '4*2' or '(1+3)*3'."),
    },
    ["thought", "expression"]
  ),

  def(
    "resolve_delivery_tile",
    "Find the coordinates of a delivery tile described by a relative word.",
    {
      thought,
      query: {
        type: "string",
        enum: ["leftmost", "rightmost", "topmost", "bottommost", "nearest"],
        description: "Which delivery tile to resolve.",
      },
    },
    ["thought", "query"]
  ),

  // ==========================================
  // Game actions
  // ==========================================

  def(
    "move_to",
    "Move to an exact map coordinate. This only moves; it does not pick up or deliver.",
    {
      thought,
      x: intParam("Target x coordinate."),
      y: intParam("Target y coordinate."),
    },
    ["thought", "x", "y"]
  ),

  def(
    "rendezvous_with_partner",
    "Move BOTH you and the BDI teammate to within maxDist tiles of (x, y) in parallel, " +
      "wait until both have confirmed arrival, then release the teammate. " +
      "Use this for any mission that says 'both agents meet at', 'wait for each other at', 'go near together', or similar rendezvous language. " +
      "Do NOT do a rendezvous manually with separate partner-direct and self-move steps — this tool does it in one step.",
    {
      thought,
      x: intParam("Meeting point x coordinate."),
      y: intParam("Meeting point y coordinate."),
      maxDist: intParam("Maximum Manhattan distance from the meeting point."),
    },
    ["thought", "x", "y", "maxDist"]
  ),

  def(
    "pick_up_parcel",
    "Move to a visible parcel and pick it up.",
    {
      thought,
      x: intParam("Parcel x coordinate."),
      y: intParam("Parcel y coordinate."),
      parcelId: param("Parcel id from the latest environment observation."),
    },
    ["thought", "x", "y", "parcelId"]
  ),

  def(
    "deliver_carried_parcels",
    "Move to a delivery tile and deliver all currently carried parcels.",
    {
      thought,
      x: intParam("Delivery tile x coordinate."),
      y: intParam("Delivery tile y coordinate."),
    },
    ["thought", "x", "y"]
  ),

  def(
    "collect_and_deliver",
    "Hand the whole collect-and-deliver job to the autonomous engine, which " +
      "finds, picks up and delivers parcels on its own (no step-by-step driving). " +
      "Use this for any open-ended or counted harvesting task — 'collect N parcels', " +
      "'deliver parcels', 'gather and deliver', 'fill up and deliver'. " +
      "It honours all active durable rules (stack size, delivery-tile and parcel-value rules). " +
      "Prefer this over manual observe_environment + pick_up_parcel + deliver_carried_parcels " +
      "loops: it is far faster and ends the mission by itself. Do NOT use it for a single " +
      "explicit move to a coordinate (use move_to) or for delivering a specific already-carried " +
      "parcel to a named tile (use deliver_carried_parcels).",
    {
      thought,
      more,
      parcels: intParam(
        "Optional target number of parcels to deliver before stopping. Omit for an open-ended 'collect parcels' request."
      ),
      timeoutMs: intParam(
        "Optional maximum time to spend, in milliseconds. Omit to use the default budget."
      ),
    },
    ["thought"]
  ),

  // ==========================================
  // Durable strategy rules
  // ==========================================

  def(
    "set_stack_size_rule",
    "Store a soft preference about how many parcels to carry before delivery. " +
      "It does not block delivery; it adjusts the delivery score. Supply the " +
      "magnitudes from the mission: penalty discourages delivering off the " +
      "target stack, reward/multiplier reward delivering on the target stack. " +
      "Several compatible rules can be active at once (e.g. at_least 2 and " +
      "at_most 5); a new rule replaces any active rule it contradicts.",
    {
      thought,
      more,
      mode: {
        type: "string",
        enum: ["exactly", "at_least", "at_most"],
        description: "Comparison mode for the carried parcel count.",
      },
      count: intParam("Positive number of parcels (the target stack)."),
      unmetPenalty: numParam(
        "Optional. Points subtracted from a delivery made OFF the target stack."
      ),
      unmetMultiplier: numParam(
        "Optional non-negative multiplier on a delivery made OFF the target stack (0 = no points off target, e.g. '0 points for fewer than 2')."
      ),
      metReward: numParam(
        "Optional. Points added to a delivery made ON the target stack."
      ),
      metMultiplier: numParam(
        "Optional non-negative multiplier on a delivery made ON the target stack (e.g. 2 = double)."
      ),
    },
    ["thought", "mode", "count"]
  ),

  def(
    "remove_stack_size_rule",
    "Remove stored stack-size rules. With mode+count, remove just that rule; " +
      "with neither, remove all of them.",
    {
      thought,
      more,
      mode: {
        type: "string",
        enum: ["exactly", "at_least", "at_most"],
        description: "Optional. Mode of the specific rule to remove.",
      },
      count: intParam("Optional. Count of the specific rule to remove."),
    },
    ["thought"]
  ),

  def(
    "set_parcel_value_rule",
    "Change how many points a parcel banks WHEN DELIVERED, for the parcels in a " +
      "value band. This is NOT a pickup restriction. Choose the bound by asking " +
      "'which parcels does the rule TARGET?': " +
      "'worth more than / over / above N' -> minReward=N (targets parcels >= N); " +
      "'worth less than / under / below N' -> maxReward=N (targets parcels <= N); " +
      "'between A and B' -> minReward=A and maxReward=B. " +
      "The targeted parcel's delivered value becomes value*mult+delta: omit both " +
      "(or mult=0, delta=0) for 'worth 0 pts', delta=5 with mult=0 for 'worth 5 " +
      "pts', mult=0.5 for 'worth half'. " +
      "WORKED EXAMPLE: 'delivered parcels under 25 are worth 0' -> maxReward=25, " +
      "mult=0, delta=0 (a parcel delivered at 30 still banks 30; one delivered at " +
      "20 banks 0). Do NOT set minReward here — that would wrongly zero the high " +
      "parcels instead of the low ones.",
    {
      thought,
      more,
      minReward: numParam("Set ONLY for 'over/above/more than N'. The rule targets parcels whose delivered value is >= this. Leave unset for an 'under N' rule."),
      maxReward: numParam("Set ONLY for 'under/below/less than N'. The rule targets parcels whose delivered value is <= this. Leave unset for an 'over N' rule."),
      mult: numParam("Optional non-negative multiplier on the targeted parcel's delivered value (default 0)."),
      delta: numParam("Optional non-negative points added to the targeted parcel's delivered value (default 0)."),
    },
    ["thought"]
  ),

  def(
    "remove_parcel_value_rule",
    "Remove all stored parcel value rules.",
    { thought, more }
  ),

  def(
    "forbid_delivery_tile",
    "Store a rule that forbids delivery at a specific delivery tile.",
    {
      thought,
      more,
      x: intParam("Delivery tile x coordinate."),
      y: intParam("Delivery tile y coordinate."),
      penalty: numParam("Optional non-negative penalty magnitude for delivering here; omit to use the default."),
    },
    ["thought", "x", "y"]
  ),

  def(
    "prefer_delivery_tile",
    "Store a rule that prefers delivery at a specific delivery tile.",
    {
      thought,
      more,
      x: intParam("Delivery tile x coordinate."),
      y: intParam("Delivery tile y coordinate."),
      reward: numParam("Optional non-negative reward magnitude for preferring this tile; omit to use the default."),
    },
    ["thought", "x", "y"]
  ),

  def(
    "set_delivery_tile_multiplier",
    "Store a reward multiplier for deliveries at a specific delivery tile.",
    {
      thought,
      more,
      x: intParam("Delivery tile x coordinate."),
      y: intParam("Delivery tile y coordinate."),
      multiplier: numParam("Non-negative multiplier, e.g. 5 for 5x or 0 for zero reward."),
    },
    ["thought", "x", "y", "multiplier"]
  ),

  def(
    "remove_delivery_tile_rule",
    "Remove any stored delivery rule for a specific delivery tile.",
    {
      thought,
      more,
      x: intParam("Delivery tile x coordinate."),
      y: intParam("Delivery tile y coordinate."),
    },
    ["thought", "x", "y"]
  ),

  def(
    "clear_durable_rules",
    "Remove all durable strategy rules.",
    { thought, more }
  ),

  // ==========================================
  // Navigation constraints
  // ==========================================

  def(
    "block_navigation_tile",
    "Forbid movement through a specific map tile.",
    {
      thought,
      more,
      x: intParam("Tile x coordinate."),
      y: intParam("Tile y coordinate."),
      penalty: numParam("Optional non-negative penalty magnitude for passing through this tile; omit to use the default."),
    },
    ["thought", "x", "y"]
  ),

  def(
    "unblock_navigation_tile",
    "Allow movement through a previously blocked map tile.",
    {
      thought,
      more,
      x: intParam("Tile x coordinate."),
      y: intParam("Tile y coordinate."),
    },
    ["thought", "x", "y"]
  ),

  // ==========================================
  // Team coordination (BDI teammate)
  // ==========================================

  def(
    "direct_partner",
    "Send ONE command to your BDI teammate and get back a correlation id (cid). " +
      "Commands: go_to (needs x,y), go_near (needs x,y,maxDist), pickup (needs x,y,parcelId), " +
      "putdown (needs x,y), wait (needs signal; optional timeoutMs), resume (no args). " +
      "The teammate runs it asynchronously and later reports the result; read that result with " +
      "wait_for_partner(cid). Always send resume when the coordinated task is finished.",
    {
      thought,
      command: {
        type: "string",
        enum: ["go_to", "go_near", "pickup", "putdown", "wait", "resume"],
        description: "Which command the teammate should perform.",
      },
      x: intParam("Target x (go_to, go_near, pickup, putdown)."),
      y: intParam("Target y (go_to, go_near, pickup, putdown)."),
      maxDist: intParam("Max Manhattan distance from the target (go_near)."),
      parcelId: param("Parcel id to pick up (pickup)."),
      signal: param("Label the teammate should wait for (wait)."),
      timeoutMs: intParam("Optional max wait in milliseconds (wait)."),
    },
    ["thought", "command"]
  ),

  def(
    "signal_partner",
    "Release the teammate's current wait by sending the signal label it is waiting on. " +
      "Use this to relay an operator 'go'/'green' to a parked teammate.",
    {
      thought,
      signal: param("Signal label to release."),
    },
    ["thought", "signal"]
  ),

  def(
    "wait_for_partner",
    "Block until the teammate reports the result of a directive you sent. " +
      "Pass the cid returned by direct_partner. Returns whether it succeeded.",
    {
      thought,
      cid: intParam("Correlation id returned by direct_partner."),
      timeoutMs: intParam("Optional max wait in milliseconds."),
    },
    ["thought", "cid"]
  ),

  // ==========================================
  // Mission termination
  // ==========================================

  def(
    "final_reply",
    "Send the final response and end the mission.",
    {
      thought: param(
        "Trace back before ending: (1) the original mission goal, " +
        "(2) what has been accomplished, (3) whether the goal is FULLY achieved. " +
        "Only call final_reply if the answer to (3) is yes."
      ),
      message: param("Concise message stating what was done or why the mission ended."),
    },
    ["thought", "message"]
  ),
];