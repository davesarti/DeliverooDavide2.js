/*
 * Stops execution for the requested number of milliseconds.
 */
export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/*
 * Defers control to the event loop without waiting a precise amount of time.
 */
export function yieldControl() {
  return new Promise((resolve) => setImmediate(resolve));
}

/*
 * Waits until the condition becomes true.
 */
export async function waitUntil(condition, delayMs = 50) {
  while (!condition()) {
    await wait(delayMs);
  }
}

/*
 * Waits while the condition remains true.
 */
export async function waitWhile(condition, delayMs = 0) {
  while (condition()) {
    if (delayMs > 0) {
      await wait(delayMs);
    } else {
      await yieldControl();
    }
  }
}