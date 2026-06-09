export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function yieldControl() {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function waitUntil(condition, delayMs = 50) {
  while (!condition()) {
    await wait(delayMs);
  }
}

export async function waitWhile(condition, delayMs = 0) {
  while (condition()) {
    if (delayMs > 0) {
      await wait(delayMs);
    } else {
      await yieldControl();
    }
  }
}