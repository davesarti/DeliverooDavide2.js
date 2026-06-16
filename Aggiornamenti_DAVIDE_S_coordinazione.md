# Report — Branch `llm-version` (16/06/2026)

## Commit `76762df` — BDI coordination fixes & timeout tuning

**File modificati:** `bdi/coordination.js`, `llm/client.js`, `llm/coordinator.js`, `llm/llmState.js`, `llm/prompts/Executor/ExecutorPrompt.js`, `llm/prompts/Executor/executorExamples.js`, `utils/constants.js`

### Bug risolti

**Freeze #1 — Tipo `cid` come stringa**
Il LLM restituiva `cid` come stringa (`"1"`) invece di intero. `coordinator.waitForPartner` usava `bufferedStatuses.has(cid)` che falliva il confronto. Fix: aggiunto `"cid"`, `"maxDist"`, `"timeoutMs"` al set `integerFields` in `client.js` per coercizione automatica.

**Freeze #2 — Auto-resume prematuro del BDI**
Il BDI si auto-riprendeva durante direttive lunghe (es. `go_to` lontano) perché `lastActivityMs` non veniva aggiornato durante l'esecuzione. Fix: `sendStatus` in `bdi/coordination.js` ora aggiorna `lastActivityMs = Date.now()`.

**Freeze #3 — `partnerParkedOn` stantio dopo timeout**
Se la direttiva `wait` scadeva lato BDI, l'LLM manteneva `partnerParkedOn` settato indefinitamente, bloccando il `finally` guard. Fix: introdotto `parkedCid` in `llmState.coordination`; `handleStatus` lo cancella alla ricezione dello status di timeout.

**Timeout troppo permissivi**
- `COORD_WAIT_DEFAULT_TIMEOUT_MS`: 60 s → 12 s
- `COORD_RESUME_IDLE_TTL_MS`: 120 s → 15 s

**Prompt — semantica errata del rendezvous**
Il LLM espandeva il rendezvous in `direct_partner("wait") + move_near + wait_for_partner`, lasciando il BDI in attesa di un segnale che non arrivava mai. Fix: regole esplicite nel prompt e negli esempi per vietare questa espansione.

---

## Commit `518681c` — Regole LLM nel BeliefState (refactor pull)

**File modificati:** 16 file, +275 / −228 righe

### Architettura

Spostamento delle regole durature da `llmState.persistentRules` (privato LLM) a `bs.rules` (condiviso), rendendo BDI e LLM coerenti sulla stessa fonte di verità.

| Prima | Dopo |
|-------|------|
| `llmState.persistentRules` (oggetto privato) | `bs.rules` (sezione del BeliefState) |
| Set di tile (`forbiddenDeliveryTiles`) | Map con magnitudine `{ penalty }` |
| Hard block in A* (`getBlockedTiles`) | Soft penalty nel costo dell'arco A* |

### Modifiche chiave

- **`beliefs/beliefState.js`** — aggiunta sezione `rules` con `penaltyTiles`, `penaltyDeliveries`, `preferredDeliveries`, `deliveryMultipliers`, `stackSize`, `parcelFilters`, `rendered`, `onChange`
- **`pathfinding/astar.js`** — legge `bs.rules?.penaltyTiles` come extra edge cost; nessuna tile è mai hard-bloccata da regole LLM
- **`llm/tools.js`** — tutti i setter di regole operano su `bs.rules`; `refreshRendered` chiama `bs.rules.onChange?.()` dopo ogni modifica
- **`utils/rulesSync.js`** *(nuovo)* — `serializeRules` / `applyRulesSnapshot` per trasporto wire (Maps → array → Maps)
- **`utils/coordProtocol.js`** — aggiunto tipo messaggio `"rules"` via `makeRulesUpdate`
- **`bdi/coordination.js`** — handler per messaggi `type: "rules"` → `applyRulesSnapshot`
- **`llm/coordinator.js`** — aggiunta funzione `syncRules()`: pushes il ruleset serializzato al partner BDI via `socket.emitSay`

---

## Commit `ad4fe74` — Strumento atomico `rendezvous_with_partner`

**File modificati:** 6 file, +78 / −25 righe

### Problema

Anche con il prompt aggiornato, il LLM poteva inserire un `direct_partner("wait")` spurio tra `go_near` e `wait_for_partner`, parcheggiando il BDI su un segnale che non sarebbe mai arrivato.

### Soluzione — Barriera atomica

Introdotto `rendezvous_with_partner` come singolo tool che internamente:
1. Invia `go_near` al partner BDI
2. Esegue `goNear` su se stesso in parallelo
3. Attende lo status del partner
4. Invia `resume` al partner

Il LLM non può interrompere la sequenza perché non la vede mai come passi separati.

**File modificati:**
- `llm/agent.js` — case `rendezvous_with_partner` in `executeTool`
- `llm/prompts/Executor/toolExecutorDefs.js` — definizione schema tool
- `llm/prompts/Executor/actionMapper.js` — mapping nome → implementazione
- `llm/prompts/Executor/ExecutorPrompt.js` — regola: "usa `rendezvous_with_partner`, mai espandere manualmente"
- `llm/prompts/Executor/executorExamples.js` — esempio corretto + sezione "comportamento errato"
- `actions/actions.js` — fix fallback `goNear`: try/catch per candidati multipli
