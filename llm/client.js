import OpenAI from "openai";
import { LLM_CONFIG } from "../config.js";

const client = new OpenAI({
  baseURL: LLM_CONFIG.baseURL,
  apiKey: LLM_CONFIG.apiKey,
});

/*
 * Chiama il modello usando function calling nativo.
 * Restituisce { action: { name, params }, toolCall } dove:
 *   - action.name   è il nome del tool scelto
 *   - action.params è l'oggetto dei parametri già parsato
 *   - toolCall      è l'oggetto raw (con id) da reinserire nella history
 * Riprova una volta automaticamente in caso di errore.
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
 * Esegue una singola richiesta al modello con function calling
 * e restituisce { ok, value } o { ok, error }.
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

  return {
    ok: true,
    value: {
      action: { name, params: parsed.value },
      toolCall,
    },
  };
}

/*
 * Prova a leggere una stringa come JSON senza sollevare eccezioni.
 */
function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}