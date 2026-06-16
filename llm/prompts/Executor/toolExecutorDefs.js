const param = (description) => ({ type: "string", description });
const intParam = (description) => ({ type: "integer", description });
const numParam = (description) => ({ type: "number", description });

const thought = param(
  "Briefly state what the latest observation shows, what the mission needs next, and why this tool is the next step."
);

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
    "get_my_position",
    "Read only your current position and score.",
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
    "move_near",
    "Move to within Manhattan distance maxDist of a coordinate. Stops at the nearest reachable tile inside that radius. Use this instead of move_to when an exact position is not required.",
    {
      thought,
      x: intParam("Target x coordinate."),
      y: intParam("Target y coordinate."),
      maxDist: intParam("Maximum Manhattan distance from the target tile."),
    },
    ["thought", "x", "y", "maxDist"]
  ),

  def(
    "rendezvous_with_partner",
    "Move BOTH you and the BDI teammate to within maxDist tiles of (x, y) in parallel, " +
      "wait until both have confirmed arrival, then release the teammate. " +
      "Use this for any mission that says 'both agents meet at', 'wait for each other at', 'go near together', or similar rendezvous language. " +
      "Do NOT use direct_partner + move_near + wait_for_partner manually for a rendezvous — this tool does it in one step.",
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
    "explore_for_parcels",
    "Search for parcels by moving toward parcel-spawn areas.",
    { thought }
  ),

  // ==========================================
  // Durable strategy rules
  // ==========================================

  def(
    "set_stack_size_rule",
    "Store a rule about how many parcels should be carried before delivery.",
    {
      thought,
      mode: {
        type: "string",
        enum: ["exactly", "at_least", "at_most"],
        description: "Comparison mode for the carried parcel count.",
      },
      count: intParam("Positive number of parcels."),
    },
    ["thought", "mode", "count"]
  ),

  def(
    "remove_stack_size_rule",
    "Remove the stored stack-size rule.",
    { thought }
  ),

  def(
    "set_parcel_reward_filter",
    "Store reward limits for parcels to ignore.",
    {
      thought,
      minReward: numParam("Ignore parcels with reward below this value."),
      maxReward: numParam("Ignore parcels with reward above this value."),
    },
    ["thought"]
  ),

  def(
    "remove_parcel_reward_filter",
    "Remove all stored parcel reward filters.",
    { thought }
  ),

  def(
    "forbid_delivery_tile",
    "Store a rule that forbids delivery at a specific delivery tile.",
    {
      thought,
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
      x: intParam("Delivery tile x coordinate."),
      y: intParam("Delivery tile y coordinate."),
    },
    ["thought", "x", "y"]
  ),

  def(
    "clear_durable_rules",
    "Remove all durable strategy rules.",
    { thought }
  ),

  // ==========================================
  // Navigation constraints
  // ==========================================

  def(
    "block_navigation_tile",
    "Forbid movement through a specific map tile.",
    {
      thought,
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
        "Before ending, trace back through this conversation: " +
        "what was the original mission goal? What has been accomplished so far? " +
        "Is the goal fully and completely achieved? Only proceed if yes."
      ),
      message: param("Concise message stating what was done or why the mission ended."),
    },
    ["thought", "message"]
  ),
];