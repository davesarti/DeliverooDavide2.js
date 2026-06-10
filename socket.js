import "dotenv/config";
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

/*
 * Crea la connessione verso Deliveroo e logga quando l'agente entra in gioco.
 */
export function createSocket(host, token) {
  const socket = DjsConnect(host, token);
  return socket;
}