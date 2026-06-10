import "dotenv/config";
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

export function createSocket(host, token) {
  const socket = DjsConnect(host, token);

  socket.onceYou((agent) => {
    console.log(`L'agente con ID ${agent.id} si è collegato a Deliveroo`);
  });

  return socket;
}