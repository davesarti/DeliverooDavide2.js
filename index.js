import { validateConfig } from "./config.js";

validateConfig();

await import("./socket.js");
await import("./beliefs/updateBeliefs.js");

console.log("Agent started");

import { generateOptions } from "./bdi/options.js";

setInterval(() => {
  const options = generateOptions();

  console.log("Generated options:");
  console.log(options);
}, 1000);