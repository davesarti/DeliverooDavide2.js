import "dotenv/config";
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

export const socket = DjsConnect();

console.log("Connected to DeliverooJS");