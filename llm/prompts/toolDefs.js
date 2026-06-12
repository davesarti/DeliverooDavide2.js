const param = (description) => ({ type: "string", description });
const intParam = (description) => ({ type: "integer", description });
const numParam = (description) => ({ type: "number", description });

const reason = param(
  "Short operational reason. Mention the relevant constraint or observation, not hidden reasoning."
);

function def(name, description, properties, required = ["reason"]) {
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
      reason,
      expression: param("One arithmetic expression only, e.g. '4*2' or '(1+3)*3'."),
    },
    ["reason", "expression"]
  ),

  def(
    "get_my_position",
    "Read this agent's current position and score. Returns JSON with id, name, x, y, score.",
    { reason }
  ),

  def(
    "find_delivery_tile",
    "Resolve a delivery tile described by words into concrete coordinates. Use when a mission or rule mentions a relative delivery tile (e.g. 'the leftmost delivery tile') and concrete coordinates are needed.",
    {
      reason,
      query: param("Exactly one of: leftmost, rightmost, topmost, bottommost, nearest."),
    },
    ["reason", "query"]
  ),

  def(
    "get_environment_state",
    "Read the current environment snapshot: me {x,y,score}; carried {count,totalReward,parcels}; visibleParcels (id,x,y,reward,distanceToMe, sorted by reward then distance); deliveryTiles (nearest first); persistentMemory (active rules). Use before choosing parcels or delivery tiles.",
    { reason }
  ),

  // ==========================================
  // Movement and game actions
  // ==========================================

  def(
    "go_to",
    "Move to a map tile. Movement only: it does not pick up or deliver parcels.",
    {
      reason,
      x: intParam("Target x coordinate."),
      y: intParam("Target y coordinate."),
    },
    ["reason", "x", "y"]
  ),

  def(
    "go_pick_up",
    "Move to a visible parcel and pick it up. Use the parcel id and coordinates from the latest get_environment_state observation.",
    {
      reason,
      x: intParam("x coordinate of the visible parcel."),
      y: intParam("y coordinate of the visible parcel."),
      parcelId: param("Parcel id exactly as returned by get_environment_state."),
    },
    ["reason", "x", "y", "parcelId"]
  ),

  def(
    "go_drop_off",
    "Move to a delivery tile and deliver all carried parcels. Use for missions containing drop, deliver, put down, or deposit.",
    {
      reason,
      x: intParam("Delivery tile x coordinate."),
      y: intParam("Delivery tile y coordinate."),
    },
    ["reason", "x", "y"]
  ),

  def(
    "explore",
    "Move toward spawn areas to search for parcels. Use when the mission requires parcels and the latest observation contains no suitable visible parcel. Observe the environment again afterwards.",
    { reason }
  ),

  // ==========================================
  // Persistent strategy rules (durable, affect future missions)
  // ==========================================

  def(
    "set_stack_size",
    "Store the durable rule: deliver only when carrying exactly / at least / at most N parcels. Replaces any previous stack-size rule.",
    {
      reason,
      mode: {
        type: "string",
        enum: ["exactly", "at_least", "at_most"],
        description: "How the carried count is compared to count.",
      },
      count: intParam("Positive integer number of parcels."),
    },
    ["reason", "mode", "count"]
  ),

  def(
    "remove_stack_size",
    "Remove the stored stack-size rule.",
    { reason }
  ),

  def(
    "set_parcel_filter",
    "Store durable parcel reward filters: ignore parcels with reward below minReward and/or above maxReward. Provide only the bounds stated in the request; each provided bound replaces the previous one.",
    {
      reason,
      minReward: numParam("Ignore parcels with reward strictly below this value."),
      maxReward: numParam("Ignore parcels with reward strictly above this value."),
    },
    ["reason"]
  ),

  def(
    "remove_parcel_filter",
    "Remove all stored parcel reward filters.",
    { reason }
  ),

  def(
    "forbid_delivery_tile",
    "Store the durable rule: never deliver at tile (x,y). Replaces any other delivery rule stored for that tile.",
    {
      reason,
      x: intParam("Delivery tile x coordinate."),
      y: intParam("Delivery tile y coordinate."),
    },
    ["reason", "x", "y"]
  ),

  def(
    "prefer_delivery_tile",
    "Store the durable rule: prefer delivering at tile (x,y). Replaces any other delivery rule stored for that tile.",
    {
      reason,
      x: intParam("Delivery tile x coordinate."),
      y: intParam("Delivery tile y coordinate."),
    },
    ["reason", "x", "y"]
  ),

  def(
    "set_delivery_multiplier",
    "Store the durable rule: deliveries at tile (x,y) give multiplier x reward (0 means zero reward). Replaces any other delivery rule stored for that tile.",
    {
      reason,
      x: intParam("Delivery tile x coordinate."),
      y: intParam("Delivery tile y coordinate."),
      multiplier: numParam("Non-negative reward multiplier, e.g. 5 for 5x, 0 for zero reward."),
    },
    ["reason", "x", "y", "multiplier"]
  ),

  def(
    "remove_delivery_tile_rule",
    "Remove whatever delivery rule (forbidden, preferred, or multiplier) is stored for tile (x,y). Use when a previous delivery restriction or preference on that tile is cancelled.",
    {
      reason,
      x: intParam("Delivery tile x coordinate."),
      y: intParam("Delivery tile y coordinate."),
    },
    ["reason", "x", "y"]
  ),

  def(
    "clear_persistent_rules",
    "Remove ALL durable strategy rules (stack size, parcel filters, delivery tile rules). Does not remove navigation blocks: use unblock_tile for those. Use only when the sender explicitly asks to forget or reset all rules.",
    { reason }
  ),

  // ==========================================
  // Navigation constraints
  // ==========================================

  def(
    "block_tile",
    "Mark tile (x,y) as forbidden for pathfinding. Use for navigation constraints such as 'do not go through / pass through / step on' a tile. Not for delivery constraints: those use forbid_delivery_tile.",
    {
      reason,
      x: intParam("x coordinate of the tile to block."),
      y: intParam("y coordinate of the tile to block."),
    },
    ["reason", "x", "y"]
  ),

  def(
    "unblock_tile",
    "Remove tile (x,y) from the pathfinding forbidden list. Use when the sender allows passing through a previously blocked tile again.",
    {
      reason,
      x: intParam("x coordinate of the tile to unblock."),
      y: intParam("y coordinate of the tile to unblock."),
    },
    ["reason", "x", "y"]
  ),

  // ==========================================
  // Mission termination
  // ==========================================

  def(
    "final_reply",
    "End the current mission and send a message back to the sender. Use when the mission is completed, a durable rule has been stored or removed, the mission is declined, required information is missing, or the mission is impossible. Do not use it just because no suitable parcel is currently visible: explore and observe again first.",
    {
      reason,
      message: param(
        "Concise but informative message: what was done, stored, delivered, declined, or why the mission cannot proceed. Avoid vague replies like 'done' or 'ok'."
      ),
    },
    ["reason", "message"]
  ),
];