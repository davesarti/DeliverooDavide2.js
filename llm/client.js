import OpenAI from "openai";
import { LLM_CONFIG } from "../config.js";

const client = new OpenAI({
  baseURL: LLM_CONFIG.baseURL,
  apiKey: LLM_CONFIG.apiKey,
});

/*
 * Richiede al modello una risposta JSON.
 * La funzione fa una prima chiamata, controlla parsing e validazione,
 * e se la risposta non è utilizzabile prova una sola correzione.
 */
export async function callLLMJson({
  messages,
  schema,
  validate,
  temperature = 0,
  retryOnInvalid = true,
}) {
  const firstResult = await requestJson({
    messages,
    schema,
    validate,
    temperature,
  });

  if (firstResult.ok) {
    return firstResult.value;
  }

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
    validate,
    temperature,
  });

  if (retryResult.ok) {
    return retryResult.value;
  }

  throw new Error(retryResult.error);
}

/*
 * Esegue una richiesta al modello e restituisce un risultato strutturato.
 * Qui viene gestito tutto quello che può andare storto nella singola risposta:
 * JSON non parsabile oppure oggetto JSON con campi non validi.
 */
async function requestJson({
  messages,
  schema,
  validate,
  temperature,
}) {
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

  const validation = validate(parsed.value);

  if (!validation.ok) {
    return {
      ok: false,
      rawContent: content,
      error: `Invalid response structure: ${validation.error}`,
    };
  }

  return {
    ok: true,
    value: parsed.value,
  };
}

/*
 * Incapsula la chiamata OpenAI-compatible.
 * Riceve i messaggi già pronti, applica eventualmente lo schema JSON,
 * e restituisce il contenuto testuale prodotto dal modello.
 */
async function callModel(
  messages,
  {
    schema = null,
    temperature = 0,
  } = {}
) {
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
 * Converte una stringa in JSON senza far crashare il chiamante.
 * Invece di lanciare errore, restituisce un oggetto con ok=true/false.
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
 * Prepara il secondo tentativo quando la prima risposta del modello è scartata.
 * Reinserisce la risposta errata nella conversazione e spiega al modello
 * perché deve correggerla.
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
        `Return the corrected JSON only.`,
    },
  ];
}