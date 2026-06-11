const param = (description) => ({ type: "string", description });
const intParam = (description) => ({ type: "integer", description });

const reason = param("Short operational reason for this action.");

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
    "Evaluate one mathematical expression. Use it when a coordinate or value is written as a formula. Never compute arithmetic yourself.",
    { reason, expression: param("The mathematical expression to evaluate.") },
    ["reason", "expression"]
  ),

  def(
    "get_my_position",
    "Read the current position of this agent.",
    { reason }
  ),

  def(
    "find_delivery_tile",
    "Find a delivery tile by textual description, such as 'leftmost' or 'nearest'.",
    { reason, query: param("Textual description of the desired delivery tile, e.g. 'leftmost', 'nearest'.") },
    ["reason", "query"]
  ),

  def(
    "go_to",
    "Move to a known tile. Use only when x and y are already known integer values.",
    { reason, x: intParam("Target x coordinate."), y: intParam("Target y coordinate.") },
    ["reason", "x", "y"]
  ),

  def(
    "go_pick_up",
    "Move to a parcel and pick it up.",
    {
      reason,
      x: intParam("Parcel x coordinate."),
      y: intParam("Parcel y coordinate."),
      parcelId: param("Id of the parcel to pick up."),
    },
    ["reason", "x", "y", "parcelId"]
  ),

  def(
    "go_drop_off",
    "Move to a delivery tile and deliver all carried parcels.",
    { reason, x: intParam("Delivery tile x coordinate."), y: intParam("Delivery tile y coordinate.") },
    ["reason", "x", "y"]
  ),

  def(
    "explore",
    "Move toward spawn areas to search for parcels.",
    { reason }
  ),

  def(
    "get_environment_state",
    "Read the current compact environment state: agent position, carried parcels, visible parcels, delivery tiles, and persistent memory. Use it before deciding pickup, dropoff, explore, or delivery-related actions when current environment information is needed.",
    { reason }
  ),

  def(
    "update_persistent_memory",
    "Update the persistent memory when the sender gives, changes, or cancels a durable rule that should affect future missions. Do not use it for one-shot missions.",
    { reason, text: param("The natural-language instruction that should update persistent memory.") },
    ["reason", "text"]
  ),

  def(
    "block_tile",
    "Mark a tile as forbidden for pathfinding. Use it when the mission says not to go through or step on a tile.",
    { reason, x: intParam("X coordinate of the tile to block."), y: intParam("Y coordinate of the tile to block.") },
    ["reason", "x", "y"]
  ),

  def(
    "unblock_tile",
    "Remove a previously blocked tile from the pathfinding forbidden list. Use it when the sender allows going through a tile again.",
    { reason, x: intParam("X coordinate of the tile to unblock."), y: intParam("Y coordinate of the tile to unblock.") },
    ["reason", "x", "y"]
  ),

  def(
    "final_reply",
    "End the mission and send a message back to the sender. Always call this when the mission is completed, declined, or impossible.",
    { reason, message: param("Message to send back to the mission sender.") },
    ["reason", "message"]
  ),
];
