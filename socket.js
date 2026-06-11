import "dotenv/config";
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

/*
 * Creates the connection to Deliveroo and logs when the agent joins the game.
 */
export function createSocket(host, token) {
  const socket = DjsConnect(host, token);
  return socket;
}