import OpenAI from "openai";
import { LLM_CONFIG } from "../config.js";
import { LLM_CALL_RETRY_DELAY_MS } from "../utils/constants.js";
import { wait } from "../utils/asyncUtils.js";

const client = new OpenAI({
  baseURL: LLM_CONFIG.baseURL,
  apiKey: LLM_CONFIG.apiKey,
  ...(LLM_CONFIG.headers ? { defaultHeaders: LLM_CONFIG.headers } : {}),
});

/*
 * Calls the model using native function calling.
 * Returns { action: { name, params }, toolCall } where:
 *   - action.name   is the name of the chosen tool
 *   - action.params is the already-parsed parameter object
 *   - toolCall      is the raw object (with id) to re-insert in the history
 * Retries once automatically on error.
 */
export async function callLLMTool({
  messages,
  tools,
  temperature = 0,
  retryOnInvalid = true,
}) {
  const firstResult = await requestTool({ messages, tools, temperature });

  if (firstResult.ok) return firstResult.value;

  if (!retryOnInvalid) {
    throw new Error(firstResult.error);
  }

  console.warn(`[callLLMTool] First attempt failed: ${firstResult.error}. Retrying...`);

  // Pause before retrying: against a rate limit or a network blip an
  // immediate second call would most likely fail the same way.
  await wait(LLM_CALL_RETRY_DELAY_MS);

  const retryResult = await requestTool({ messages, tools, temperature });

  if (retryResult.ok) return retryResult.value;

  throw new Error(retryResult.error);
}

/*
 * Executes a single request to the model with function calling
 * and returns { ok, value } or { ok, error }. A thrown API error (rate limit,
 * network failure, timeout) is folded into { ok: false } too: it is the most
 * transient failure class of all, so it must go through the same single-retry
 * path as an invalid response instead of failing the mission outright.
 */
async function requestTool({ messages, tools, temperature }) {
  const request = {
    model: LLM_CONFIG.model,
    messages,
    tools,
    tool_choice: "required",
    temperature,
  };

  let response;
  try {
    response = await client.chat.completions.create(request);
  } catch (error) {
    return { ok: false, error: `API call failed: ${error?.message ?? error}` };
  }

  const toolCall = response.choices?.[0]?.message?.tool_calls?.[0];

  if (!toolCall) {
    return { ok: false, error: "Model did not return a tool call." };
  }

  const name = toolCall.function.name;
  const parsed = safeJsonParse(toolCall.function.arguments);

  if (!parsed.ok) {
    return { ok: false, error: `Invalid tool arguments: ${parsed.error}` };
  }

  coerceNumericParams(parsed.value);

  return {
    ok: true,
    value: {
      action: { name, params: parsed.value },
      toolCall,
    },
  };
}

/*
 * Tries to parse a string as JSON without raising exceptions.
 */
function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function coerceNumericParams(obj) {
  const integerFields = new Set(["x", "y", "count", "cid", "maxDist", "timeoutMs", "parcels"]);
  const floatFields = new Set([
    "minReward",
    "maxReward",
    "multiplier",
    "mult",
    "delta",
    "penalty",
    "reward",
    "metReward",
    "metMultiplier",
    "unmetPenalty",
    "unmetMultiplier",
  ]);

  for (const key in obj) {
    if (typeof obj[key] !== "string") continue;

    const trimmed = obj[key].trim();

    if (integerFields.has(key) && /^-?\d+$/.test(trimmed)) {
      obj[key] = Number(trimmed);
    } else if (floatFields.has(key) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
      obj[key] = Number(trimmed);
    }
  }

  return obj;
}