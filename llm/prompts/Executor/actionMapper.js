const ACTION_NAME_MAP = {
  // Information tools
  observe_environment: "get_environment_state",
  resolve_delivery_tile: "find_delivery_tile",

  calculate: "calculate",
  get_my_position: "get_my_position",

  // Game actions
  move_to: "go_to",
  move_near: "go_near",
  pick_up_parcel: "go_pick_up",
  deliver_carried_parcels: "go_drop_off",
  explore_for_parcels: "explore",

  // Durable strategy rules
  set_stack_size_rule: "set_stack_size",
  remove_stack_size_rule: "remove_stack_size",

  set_parcel_reward_filter: "set_parcel_filter",
  remove_parcel_reward_filter: "remove_parcel_filter",

  forbid_delivery_tile: "forbid_delivery_tile",
  prefer_delivery_tile: "prefer_delivery_tile",
  set_delivery_tile_multiplier: "set_delivery_multiplier",
  remove_delivery_tile_rule: "remove_delivery_tile_rule",

  clear_durable_rules: "clear_persistent_rules",

  // Navigation constraints
  block_navigation_tile: "block_tile",
  unblock_navigation_tile: "unblock_tile",

  // Team coordination
  direct_partner: "direct_partner",
  signal_partner: "signal_partner",
  wait_for_partner: "wait_for_partner",
  rendezvous_with_partner: "rendezvous_with_partner",

  // Mission termination
  final_reply: "final_reply",
};

export function mapExecutorAction(action) {
  if (!action?.name) {
    return action;
  }

  return {
    ...action,
    name: ACTION_NAME_MAP[action.name] ?? action.name,
  };
}