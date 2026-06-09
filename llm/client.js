import OpenAI from "openai";
import { LLM_CONFIG } from "../config.js";

const client = new OpenAI({
  baseURL: LLM_CONFIG.baseURL,
  apiKey: LLM_CONFIG.apiKey,
});

/*
 * Chiama il modello chiedendo una risposta JSON.
 * Questa funzione gestisce parsing, validazione strutturale e un retry automatico.
 */
export async function callLLMJson({
  messages,
  schema,
  temperature = 0,
  retryOnInvalid = true,
}) {
  const firstResult = await requestJson({
    messages,
    schema,
    temperature,
  });

  if (firstResult.ok) return firstResult.value;

  if (!retryOnInvalid) {
    throw new Error(firstResult.error);
  }

  const retryMessages = buildRetryMessages(
    messages,
    firstResult.rawContent,
    firstResult.error
  );

  const retryResult = await requestJson({
    messages: retryMessages,
    schema,
    temperature,
  });

  if (retryResult.ok) return retryResult.value;

  throw new Error(retryResult.error);
}

/*
 * Esegue una singola richiesta al modello e controlla che la risposta sia JSON valido
 * e che rispetti la struttura del piano attesa dall'agente.
 */
async function requestJson({ messages, schema, temperature }) {
  const content = await callModel(messages, {
    schema,
    temperature,
  });

  const parsed = safeJsonParse(content);

  if (!parsed.ok) {
    return {
      ok: false,
      rawContent: content,
      error: `Invalid JSON: ${parsed.error}`,
    };
  }

  const validation = validatePlanJson(parsed.value);

  if (!validation.ok) {
    return {
      ok: false,
      rawContent: content,
      error: `Invalid plan JSON: ${validation.error}`,
    };
  }

  return {
    ok: true,
    value: parsed.value,
  };
}

/*
 * Incapsula la chiamata OpenAI-compatible.
 * Riceve i messaggi già costruiti e restituisce il contenuto testuale del modello.
 */
async function callModel(messages, { schema = null, temperature = 0 } = {}) {
  const request = {
    model: LLM_CONFIG.model,
    messages,
    temperature,
  };

  if (schema) {
    request.response_format = {
      type: "json_schema",
      json_schema: schema,
    };
  }

  const response = await client.chat.completions.create(request);

  return response.choices?.[0]?.message?.content ?? "";
}

/*
 * Prova a convertire una stringa in JSON.
 * Non lancia eccezioni: restituisce sempre un oggetto con ok true/false.
 */
function safeJsonParse(text) {
  try {
    return {
      ok: true,
      value: JSON.parse(text),
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
    };
  }
}

/*
 * Valida la struttura logica del piano JSON prodotto dall'LLM.
 * Qui controlliamo solo il formato del piano, non se sia davvero eseguibile nel mondo corrente.
 */
function validatePlanJson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      error: "The response must be a JSON object.",
    };
  }

  if (!Array.isArray(value.plan)) {
    return {
      ok: false,
      error: "The response must contain a plan array.",
    };
  }

  if (value.plan.length === 0) {
    return {
      ok: false,
      error: "The plan array cannot be empty.",
    };
  }

  for (const [index, step] of value.plan.entries()) {
    const validation = validatePlanStep(step);

    if (!validation.ok) {
      return {
        ok: false,
        error: `Invalid step at index ${index}: ${validation.error}`,
      };
    }
  }

  return { ok: true };
}

/*
 * Valida un singolo step del piano JSON.
 * Controlla che l'azione esista e che i parametri richiesti siano presenti.
 */
function validatePlanStep(step) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    return {
      ok: false,
      error: "Each step must be an object.",
    };
  }

  if (typeof step.action !== "string") {
    return {
      ok: false,
      error: "Each step must contain an action string.",
    };
  }

  if (step.action === "go_pick_up") {
    if (typeof step.parcelId !== "string") {
      return {
        ok: false,
        error: "go_pick_up requires parcelId as string.",
      };
    }

    return { ok: true };
  }

  if (step.action === "go_drop_off") {
    if (!Number.isFinite(step.x) || !Number.isFinite(step.y)) {
      return {
        ok: false,
        error: "go_drop_off requires numeric x and y.",
      };
    }

    return { ok: true };
  }

  if (step.action === "explore") {
    return { ok: true };
  }

  return {
    ok: false,
    error: `Unknown action "${step.action}".`,
  };
}

/*
 * Costruisce i messaggi per il secondo tentativo.
 * Mostra al modello la risposta sbagliata e gli chiede di correggere solo il JSON.
 */
function buildRetryMessages(messages, invalidOutput, error) {
  return [
    ...messages,
    {
      role: "assistant",
      content: invalidOutput || "",
    },
    {
      role: "user",
      content:
        `Your previous response was rejected.\n` +
        `Reason: ${error}\n\n` +
        `Return only corrected JSON. Do not add explanations.`,
    },
  ];
}