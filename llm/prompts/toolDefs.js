const param = (description) => ({ type: "string", description });
const intParam = (description) => ({ type: "integer", description });

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
  def(
    "calculate",
    "Evaluate exactly one arithmetic expression and return its numeric result. Use only when a single coordinate or value is written as an expression, e.g. x=4*2 or y=(1+3)*3. Do not use for plain integers, coordinate pairs like (1,1), placeholders like (x,y), normal questions, or strategic decisions.",
    {
      reason,
      expression: param(
        "One arithmetic expression only, e.g. '4*2' or '(1+3)*3'. Do not pass coordinate pairs such as '(1,1)'."
      ),
    },
    ["reason", "expression"]
  ),

  def(
    "get_my_position",
    "Read this agent's current position and score. Returns JSON with id, name, x, y, and score. Use when the current mission explicitly depends on where this agent is now.",
    { reason }
  ),

  def(
    "find_delivery_tile",
    "Resolve a delivery tile described by words into concrete coordinates. Supported queries are: leftmost, rightmost, topmost, bottommost, nearest. Use when a mission mentions a relative delivery tile and only its coordinates are needed.",
    {
      reason,
      query: param("Exactly one of: leftmost, rightmost, topmost, bottommost, nearest."),
    },
    ["reason", "query"]
  ),

  def(
    "go_to",
    "Move to a known map tile. Use only for immediate movement missions with concrete integer coordinates. This action only moves: it does not pick up parcels, does not drop packages, and does not deliver parcels. Never use it to satisfy missions containing drop, deliver, put down, or deposit.",
    {
      reason,
      x: intParam("Concrete target x coordinate."),
      y: intParam("Concrete target y coordinate."),
    },
    ["reason", "x", "y"]
  ),

  def(
    "go_pick_up",
    "Move to a known visible parcel and pick it up. Use only after get_environment_state has provided that parcel's id, x, y, and reward. Persistent memory is mandatory: never pick up a parcel that violates a persistent reward filter or strategy rule. If no visible parcel satisfies persistent memory and the mission still requires parcels, use explore and observe again. Use final_reply only when the mission is truly impossible or required information is missing.",
    {
      reason,
      x: intParam("Concrete x coordinate of the visible parcel."),
      y: intParam("Concrete y coordinate of the visible parcel."),
      parcelId: param("Parcel id exactly as returned by get_environment_state."),
    },
    ["reason", "x", "y", "parcelId"]
  ),

  def(
    "go_drop_off",
    "Move to a known delivery tile and deliver all carried parcels. Use for missions containing drop, deliver, put down, or deposit on a delivery tile. Persistent memory is mandatory: do not deliver before the required carried count, do not deliver in forbidden or zero-reward delivery tiles, and do not deliver carried parcels that violate persistent reward filters unless the current mission explicitly changes that rule.",
    {
      reason,
      x: intParam("Concrete delivery tile x coordinate."),
      y: intParam("Concrete delivery tile y coordinate."),
    },
    ["reason", "x", "y"]
  ),

  def(
    "explore",
    "Move toward spawn areas to search for parcels. Use when the current mission requires parcels and the latest environment observation contains no suitable visible parcel according to persistent memory. After exploring, observe the environment again before deciding whether the mission can continue.",
    { reason }
  ),

  def(
    "get_environment_state",
    "Read the current compact environment state. Returns JSON with: me {x,y,score}; carried {count,totalReward,parcels}; visibleParcels sorted by reward and distance, each with id,x,y,reward,distanceToMe; deliveryTiles sorted from nearest to farthest, each with x,y,distanceToMe; persistentMemory. Use before choosing parcels, checking carried count, selecting a delivery tile, resolving nearest delivery tile from current state, or applying persistent strategy rules.",
    { reason }
  ),

  def(
    "update_persistent_memory",
    "Update durable non-navigation strategy rules that must affect future missions. Use for delivery preferences, delivery reward multipliers, delivery tiles to avoid, stack size before delivery, and parcel reward filters. Do not use for one-shot missions or navigation constraints. Do not pass unresolved relative descriptions such as 'nearest delivery tile' or placeholders such as '(x,y)': resolve them to concrete coordinates first, or ask for missing information.",
    {
      reason,
      text: param(
        "Concrete natural-language rule to store, update, or remove. Use concrete coordinates and concrete thresholds. Do not include unresolved placeholders or relative tile descriptions."
      ),
    },
    ["reason", "text"]
  ),

  def(
    "block_tile",
    "Mark a concrete tile as forbidden for pathfinding. Use only for navigation constraints such as 'do not go through', 'do not pass through', or 'do not step on' a tile. Do not use for delivery-only constraints. Do not call this tool unless x and y are known integer coordinates; if coordinates are placeholders or missing, use final_reply to ask for concrete coordinates.",
    {
      reason,
      x: intParam("Concrete integer x coordinate of the tile to block."),
      y: intParam("Concrete integer y coordinate of the tile to block."),
    },
    ["reason", "x", "y"]
  ),

  def(
    "unblock_tile",
    "Remove a previously blocked tile from the pathfinding forbidden list. Use only when the sender explicitly allows going through, passing through, or stepping on a previously forbidden concrete tile again. Do not use for delivery-permission changes. Use only with known integer coordinates.",
    {
      reason,
      x: intParam("Concrete integer x coordinate of the tile to unblock."),
      y: intParam("Concrete integer y coordinate of the tile to unblock."),
    },
    ["reason", "x", "y"]
  ),

  def(
    "final_reply",
    "End the current mission and send a message back to the sender. Use only when the mission has been completed, a durable rule has been updated, an immediate mission is declined because it is unprofitable, required information is missing, or the mission is truly impossible. Do not use final_reply just because no suitable parcel is currently visible: explore and observe again first. The message must be concise but informative.",
    {
      reason,
      message: param(
        "Concise message for the sender. Include what was done or why it could not be done. Avoid vague replies like 'done', 'completed', or 'ok' when details are available."
      ),
    },
    ["reason", "message"]
  )
];