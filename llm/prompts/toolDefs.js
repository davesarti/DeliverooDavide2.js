const param = (description) => ({ type: "string", description });
const intParam = (description) => ({ type: "integer", description });
const numParam = (description) => ({ type: "number", description });

const thought = param(
  "Think before acting. In one or two natural sentences, work out what the latest observation tells you, where you are relative to the mission goal, and why this action follows. Ground it in real values you can see (rewards, coordinates, carried count) rather than restating the plan. Keep it short when the step is obvious."
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

export const MISSION_TOOLS = [
  // ==========================================
  // Information tools
  // ==========================================

  def(
    "calculate",
    "Evaluate exactly one arithmetic expression and return its numeric result. Use only when a single coordinate or value is written as an expression, e.g. x=4*2. Do not use for plain integers or coordinate pairs.",
    {
      thought,
      expression: param("One arithmetic expression only, e.g. '4*2' or '(1+3)*3'."),
    },
    ["thought", "expression"]
  ),

  def(
    "get_my_position",
    "Read this agent's current position and score. Returns JSON with id, name, x, y, score.",
    { thought }
  ),

  def(
    "find_delivery_tile",
    "Resolve a delivery tile described by words into concrete coordinates. Use when a mission or rule mentions a relative delivery tile (e.g. 'the leftmost delivery tile') and concrete coordinates are needed.",
    {
      thought,
      query: param("Exactly one of: leftmost, rightmost, topmost, bottommost, nearest."),
    },
    ["thought", "query"]
  ),

  def(
    "get_environment_state",
    "Read the current environment snapshot: me {x,y,score}; carried {count,totalReward,parcels}; visibleParcels (id,x,y,reward,distanceToMe, sorted by reward then distance); deliveryTiles (nearest first, with rewardMultiplier and preferred flags when set); persistentMemory (active rules). visibleParcels already excludes parcels rejected by the active reward filter, and deliveryTiles already excludes forbidden tiles: every parcel and tile listed is a valid choice. Use before choosing parcels or delivery tiles.",
    { thought }
  ),

  // ==========================================
  // Movement and game actions
  // ==========================================

  def(
    "go_to",
    "Move to a map tile. Movement only: it does not pick up or deliver parcels.",
    {
      thought,
      x: intParam("Target x coordinate."),
      y: intParam("Target y coordinate."),
    },
    ["thought", "x", "y"]
  ),

  def(
    "go_pick_up",
    "Move to a visible parcel and pick it up. Use the parcel id and coordinates from the latest get_environment_state observation. Every parcel in visibleParcels already satisfies the active filter, so any of them can be picked up.",
    {
      thought,
      x: intParam("x coordinate of the visible parcel."),
      y: intParam("y coordinate of the visible parcel."),
      parcelId: param("Parcel id exactly as returned by get_environment_state."),
    },
    ["thought", "x", "y", "parcelId"]
  ),

  def(
    "go_drop_off",
    "Move to a delivery tile and deliver all carried parcels. Use for missions containing drop, deliver, put down, or deposit.",
    {
      thought,
      x: intParam("Delivery tile x coordinate."),
      y: intParam("Delivery tile y coordinate."),
    },
    ["thought", "x", "y"]
  ),

  def(
    "explore",
    "Move toward spawn areas to search for parcels. Use when the mission requires parcels and the latest observation contains no suitable visible parcel. Always call get_environment_state after exploring to reassess. For collection missions requiring many parcels, multiple explore cycles may be needed: one failed explore is not grounds for failure.",
    { thought }
  ),

  // ==========================================
  // Persistent strategy rules (durable, affect future missions)
  // ==========================================

  def(
    "set_stack_size",
    "Store the durable rule: deliver only when carrying exactly / at least / at most N parcels. Replaces any previous stack-size rule automatically: do not call remove_stack_size before this.",
    {
      thought,
      mode: {
        type: "string",
        enum: ["exactly", "at_least", "at_most"],
        description: "How the carried count is compared to count.",
      },
      count: intParam("Positive integer number of parcels."),
    },
    ["thought", "mode", "count"]
  ),

  def(
    "remove_stack_size",
    "Remove the stored stack-size rule.",
    { thought }
  ),

  def(
    "set_parcel_filter",
    "Store durable parcel reward filters: ignore parcels with reward below minReward and/or above maxReward. Provide only the bounds stated in the request; each provided bound replaces the previous one. Omit parameters not needed: do not pass null or the string 'null' for unused bounds.",
    {
      thought,
      minReward: numParam("Ignore parcels with reward strictly below this value."),
      maxReward: numParam("Ignore parcels with reward strictly above this value."),
    },
    ["thought"]
  ),

  def(
    "remove_parcel_filter",
    "Remove all stored parcel reward filters.",
    { thought }
  ),

  def(
    "forbid_delivery_tile",
    "Store the durable rule: never deliver at tile (x,y). Replaces any other delivery rule stored for that tile.",
    {
      thought,
      x: intParam("Delivery tile x coordinate."),
      y: intParam("Delivery tile y coordinate."),
    },
    ["thought", "x", "y"]
  ),

  def(
    "prefer_delivery_tile",
    "Store the durable rule: prefer delivering at tile (x,y). Replaces any other delivery rule stored for that tile.",
    {
      thought,
      x: intParam("Delivery tile x coordinate."),
      y: intParam("Delivery tile y coordinate."),
    },
    ["thought", "x", "y"]
  ),

  def(
    "set_delivery_multiplier",
    "Store the durable rule: deliveries at tile (x,y) give multiplier x reward (0 means zero reward). Replaces any other delivery rule stored for that tile.",
    {
      thought,
      x: intParam("Delivery tile x coordinate."),
      y: intParam("Delivery tile y coordinate."),
      multiplier: numParam("Non-negative reward multiplier, e.g. 5 for 5x, 0 for zero reward."),
    },
    ["thought", "x", "y", "multiplier"]
  ),

  def(
    "remove_delivery_tile_rule",
    "Remove whatever delivery rule (forbidden, preferred, or multiplier) is stored for tile (x,y). Use when a previous delivery restriction or preference on that tile is cancelled.",
    {
      thought,
      x: intParam("Delivery tile x coordinate."),
      y: intParam("Delivery tile y coordinate."),
    },
    ["thought", "x", "y"]
  ),

  def(
    "clear_persistent_rules",
    "Remove ALL durable strategy rules (stack size, parcel filters, delivery tile rules). Does not remove navigation blocks: use unblock_tile for those. Use only when the sender explicitly asks to forget or reset all rules.",
    { thought }
  ),

  // ==========================================
  // Navigation constraints
  // ==========================================

  def(
    "block_tile",
    "Mark tile (x,y) as forbidden for pathfinding. Use for navigation constraints such as 'do not go through / pass through / step on' a tile. Not for delivery constraints: those use forbid_delivery_tile.",
    {
      thought,
      x: intParam("x coordinate of the tile to block."),
      y: intParam("y coordinate of the tile to block."),
    },
    ["thought", "x", "y"]
  ),

  def(
    "unblock_tile",
    "Remove tile (x,y) from the pathfinding forbidden list. Use when the sender allows passing through a previously blocked tile again.",
    {
      thought,
      x: intParam("x coordinate of the tile to unblock."),
      y: intParam("y coordinate of the tile to unblock."),
    },
    ["thought", "x", "y"]
  ),

  // ==========================================
  // Mission termination
  // ==========================================

  def(
    "final_reply",
    "End the current mission and send a message back to the sender. Use when the mission is completed, a durable rule has been stored or removed, the mission is declined, required information is missing, or the mission is impossible. Do not use it just because no suitable parcel is currently visible: explore and observe again first.",
    {
      thought,
      message: param(
        "Concise but informative message: what was done, stored, delivered, declined, or why the mission cannot proceed. Avoid vague replies like 'done' or 'ok'."
      ),
    },
    ["thought", "message"]
  ),
];