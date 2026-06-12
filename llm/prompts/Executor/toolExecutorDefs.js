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
    "Move to a map coordinate. This only moves; it does not pick up or deliver.",
    {
      thought,
      x: intParam("Target x coordinate."),
      y: intParam("Target y coordinate."),
    },
    ["thought", "x", "y"]
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
  // Mission termination
  // ==========================================

  def(
    "final_reply",
    "Send the final response and end the current mission.",
    {
      thought,
      message: param("Concise message stating what was done or why the mission ended."),
    },
    ["thought", "message"]
  ),
];