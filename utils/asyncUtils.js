/*
 * Ferma l'esecuzione per il numero di millisecondi richiesto.
 */
export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/*
 * Rimanda il controllo al loop dell'evento senza aspettare un tempo preciso.
 */
export function yieldControl() {
  return new Promise((resolve) => setImmediate(resolve));
}

/*
 * Attende finché la condizione non diventa vera.
 */
export async function waitUntil(condition, delayMs = 50) {
  while (!condition()) {
    await wait(delayMs);
  }
}

/*
 * Attende finché la condizione resta vera.
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