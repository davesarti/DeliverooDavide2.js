import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_DIR = path.join(__dirname, "history");

// ==========================================
// Helpers
// ==========================================

const MAX_OBSERVATION_LENGTH = 800;

function toSessionId(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const y  = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d  = pad(date.getDate());
  const h  = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const s  = pad(date.getSeconds());
  return `${y}-${mo}-${d}_${h}-${mi}-${s}`;
}

function toMissionId(n) {
  return `m_${String(n).padStart(4, "0")}`;
}

function truncate(value) {
  if (typeof value !== "string") return value;
  if (value.length <= MAX_OBSERVATION_LENGTH) return value;
  return value.slice(0, MAX_OBSERVATION_LENGTH) + ` …[truncated ${value.length - MAX_OBSERVATION_LENGTH} chars]`;
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function appendJSONL(filePath, obj) {
  try {
    fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
  } catch (err) {
    console.error("[historyLogger] JSONL write failed:", err.message);
  }
}

// ==========================================
// createSessionLogger
// ==========================================

/*
 * Creates a structured experiment logger for a single agent session.
 * Each session gets its own directory under history/ with five files:
 *
 *   events.jsonl          – append-only stream of every event in chronological order
 *   missions.json         – per-mission summary rebuilt after each mission ends
 *   summary.json          – aggregate statistics rebuilt after each mission ends
 *   config.json           – static session parameters written once on creation
 *   rules_timeline.jsonl  – chronological log of every rule change across the session
 *
 * missions.json entries include:
 *   rulesAtStart        – rendered rules active when the mission began
 *   rulesAtEnd          – rendered rules after the mission completed
 *   ruleChanges         – list of rule-tool calls made during this mission
 *   constraintViolations – count of actions rejected by the rules validator
 *   deliveries          – list of successful deliveries {x, y, parcels}
 *
 * All I/O is synchronous and wrapped in try/catch so logging failures
 * never crash or stall the agent.
 */
export function createSessionLogger({ maxIterations, model } = {}) {
  const sessionId = toSessionId();
  const sessionDir = path.join(HISTORY_DIR, sessionId);

  try {
    fs.mkdirSync(sessionDir, { recursive: true });
  } catch (err) {
    console.error("[historyLogger] Cannot create session directory:", err.message);
    return createNoopLogger(sessionId);
  }

  const eventsPath        = path.join(sessionDir, "events.jsonl");
  const missionsPath      = path.join(sessionDir, "missions.json");
  const summaryPath       = path.join(sessionDir, "summary.json");
  const configPath        = path.join(sessionDir, "config.json");
  const rulesTimelinePath = path.join(sessionDir, "rules_timeline.jsonl");
  const bdiDecisionsPath  = path.join(sessionDir, "bdi_decisions.jsonl");

  // ---- Internal state ----

  let missionCounter = 0;
  const missions = new Map(); // missionId -> mission object

  const summary = {
    sessionId,
    missionsReceived:    0,
    missionsCompleted:   0,
    missionsFailed:      0,
    runtimeRejections:   0,
    totalRuleChanges:    0,
    totalDeliveries:     0,
  };

  // ---- Initialise static files ----

  const config = {
    sessionId,
    maxIterations: maxIterations ?? null,
    model:         model         ?? "unknown",
    startedAt:     new Date().toISOString(),
  };

  try { writeJSON(configPath, config);   } catch {}
  try { writeJSON(missionsPath, []);     } catch {}
  try { writeJSON(summaryPath, summary); } catch {}

  // ---- Core append ----

  /*
   * Appends a BDI decision event to bdi_decisions.jsonl.
   * Kept separate from events.jsonl to avoid bloating the mission log.
   */
  function logBdiEvent(type, data) {
    appendJSONL(bdiDecisionsPath, { time: new Date().toISOString(), type, data });
  }

  function logEvent(type, data, missionId = null) {
    const event = {
      time: new Date().toISOString(),
      sessionId,
      ...(missionId ? { missionId } : {}),
      type,
      data,
    };
    try {
      fs.appendFileSync(eventsPath, JSON.stringify(event) + "\n", "utf8");
    } catch (err) {
      console.error("[historyLogger] Event write failed:", err.message);
    }
  }

  // ---- Flush helpers ----

  function flushMissions() {
    try { writeJSON(missionsPath, [...missions.values()]); } catch {}
  }

  function flushSummary() {
    try { writeJSON(summaryPath, summary); } catch {}
  }

  // ---- Public API ----

  /*
   * Call when a chat message arrives.
   * rulesAtStart: bs.rules.rendered at the moment the mission begins.
   * Returns the missionId to carry through the rest of the mission.
   */
  function startMission(request, rulesAtStart = "None.") {
    missionCounter++;
    const missionId = toMissionId(missionCounter);
    const startedAt = new Date().toISOString();

    missions.set(missionId, {
      missionId,
      request,
      status:              "running",
      reply:               null,
      rulesAtStart,
      rulesAtEnd:          null,
      ruleChanges:         [],
      constraintViolations: 0,
      deliveries:          [],
      startedAt,
      endedAt:             null,
      steps:               0,
    });

    summary.missionsReceived++;
    logEvent("mission_received", { request, rulesAtStart }, missionId);
    return missionId;
  }

  /*
   * Call after each Executor tool call, before execution.
   */
  function logExecutorAction(missionId, { rawName, mappedName, params, thought }) {
    const m = missions.get(missionId);
    if (m) m.steps++;

    logEvent("executor_raw_action", { name: rawName, params, thought }, missionId);

    if (rawName !== mappedName) {
      logEvent("executor_mapped_action", { from: rawName, to: mappedName }, missionId);
    }
  }

  /*
   * Call when a rule-modifying tool completes successfully.
   * toolName: mapped action name (e.g. "set_stack_size")
   * params:   tool parameters
   * rulesAfter: bs.rules.rendered after the change
   */
  function logRuleChange(missionId, toolName, params, rulesAfter) {
    const entry = {
      time:      new Date().toISOString(),
      missionId,
      tool:      toolName,
      params,
      rulesAfter,
    };

    const m = missions.get(missionId);
    if (m) m.ruleChanges.push({ tool: toolName, params, rulesAfter });

    summary.totalRuleChanges++;

    appendJSONL(rulesTimelinePath, entry);
    logEvent("rule_change", { tool: toolName, params, rulesAfter }, missionId);
  }

  /*
   * Call when go_drop_off completes successfully.
   */
  function logDelivery(missionId, x, y, count) {
    const m = missions.get(missionId);
    if (m) m.deliveries.push({ x, y, parcels: count });

    summary.totalDeliveries += count;
    logEvent("delivery", { x, y, parcels: count }, missionId);
  }

  /*
   * Call when rulesValidator.js rejects an action.
   */
  function logActionRejected(missionId, actionName, reason) {
    summary.runtimeRejections++;
    const m = missions.get(missionId);
    if (m) m.constraintViolations++;
    logEvent("action_rejected", { action: actionName, reason }, missionId);
  }

  /*
   * Call after a tool returns its observation string.
   */
  function logObservation(missionId, actionName, observation) {
    logEvent("tool_observation", {
      action:      actionName,
      observation: truncate(observation),
    }, missionId);
  }

  /*
   * Call when the Executor calls final_reply.
   */
  function logFinalReply(missionId, message) {
    logEvent("final_reply", { message }, missionId);
  }

  /*
   * Call when the mission loop finishes (success or failure).
   * status: "completed" | "failed"
   * rulesAtEnd: bs.rules.rendered at mission end (may differ from rulesAtStart
   * if the mission stored or removed rules).
   */
  function endMission(missionId, status, reply, rulesAtEnd = null) {
    const m = missions.get(missionId);
    if (!m) return;

    m.status   = status;
    m.reply    = reply;
    m.rulesAtEnd = rulesAtEnd ?? m.rulesAtStart;
    m.endedAt  = new Date().toISOString();

    if (status === "completed") summary.missionsCompleted++;
    else                        summary.missionsFailed++;

    logEvent(
      status === "completed" ? "mission_completed" : "mission_failed",
      {
        reply,
        steps:               m.steps,
        ruleChanges:         m.ruleChanges.length,
        constraintViolations: m.constraintViolations,
        deliveries:          m.deliveries.length,
        rulesChanged:        m.rulesAtEnd !== m.rulesAtStart,
      },
      missionId
    );

    flushMissions();
    flushSummary();
  }

  /*
   * Call on process exit to close the session cleanly.
   */
  function endSession() {
    const durationMs = Date.now() - new Date(config.startedAt).getTime();
    logEvent("session_ended", { totalMissions: missionCounter, durationMs });
    appendJSONL(rulesTimelinePath, {
      time: new Date().toISOString(),
      type: "session_ended",
      totalRuleChanges: summary.totalRuleChanges,
      durationMs,
    });
    flushMissions();
    flushSummary();
  }

  // Write session_started to events, rules_timeline, and bdi_decisions
  logEvent("session_started", { sessionId, model: config.model });
  appendJSONL(bdiDecisionsPath, {
    time:  new Date().toISOString(),
    type:  "session_started",
    model: config.model,
  });
  appendJSONL(rulesTimelinePath, {
    time:  new Date().toISOString(),
    type:  "session_started",
    model: config.model,
    rules: "None.",
  });

  return {
    sessionId,
    sessionDir,
    logEvent,
    logBdiEvent,
    startMission,
    logExecutorAction,
    logRuleChange,
    logDelivery,
    logActionRejected,
    logObservation,
    logFinalReply,
    endMission,
    endSession,
  };
}

// ==========================================
// No-op logger (fallback if directory creation fails)
// ==========================================

function createNoopLogger(sessionId) {
  const noop = () => {};
  return {
    sessionId,
    sessionDir:        null,
    logEvent:          noop,
    logBdiEvent:       noop,
    startMission:      () => "m_0000",
    logExecutorAction: noop,
    logRuleChange:     noop,
    logDelivery:       noop,
    logActionRejected: noop,
    logObservation:    noop,
    logFinalReply:     noop,
    endMission:        noop,
    endSession:        noop,
  };
}
