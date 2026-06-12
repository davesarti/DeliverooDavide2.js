import OpenAI from "openai";
import { LLM_CONFIG } from "../config.js";

const client = new OpenAI({
  baseURL: LLM_CONFIG.baseURL,
  apiKey: LLM_CONFIG.apiKey,
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

  const retryResult = await requestTool({ messages, tools, temperature });

  if (retryResult.ok) return retryResult.value;

  throw new Error(retryResult.error);
}

/*
 * Executes a single request to the model with function calling
 * and returns { ok, value } or { ok, error }.
 */
async function requestTool({ messages, tools, temperature }) {
  const request = {
    model: LLM_CONFIG.model,
    messages,
    tools,
    tool_choice: "required",
    temperature,
  };

  const response = await client.chat.completions.create(request);

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
  const integerFields = new Set(["x", "y", "count"]);
  const floatFields = new Set(["minReward", "maxReward", "multiplier"]);

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