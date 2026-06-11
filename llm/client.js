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

/*
* Calls the model without function calling and returns the response text.
*/
export async function callLLMText({ messages, temperature = 0 }) {
  const request = {
    model: LLM_CONFIG.model,
    messages,
    temperature,
  };

  const response = await client.chat.completions.create(request);

  return response.choices?.[0]?.message?.content ?? "";
}

function coerceNumericParams(obj) {
  const numericFields = new Set(["x", "y"]);

  for (const key in obj) {
    if (
      numericFields.has(key) &&
      typeof obj[key] === "string" &&
      /^-?\d+$/.test(obj[key].trim())
    ) {
      obj[key] = Number(obj[key].trim());
    }
  }

  return obj;
}