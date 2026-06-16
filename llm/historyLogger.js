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
  return date.toISOString().replace(/:/g, "-").replace(/\./g, "-");
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

// ==========================================
// createSessionLogger
// ==========================================

/*
 * Creates a structured experiment logger for a single agent session.
 * Each session gets its own directory under history/ with four files:
 *
 *   events.jsonl  – append-only stream of every event in chronological order
 *   missions.json – per-mission summary rebuilt after each mission ends
 *   summary.json  – aggregate statistics rebuilt after each mission ends
 *   config.json   – static session parameters written once on creation
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

  const eventsPath   = path.join(sessionDir, "events.jsonl");
  const missionsPath = path.join(sessionDir, "missions.json");
  const summaryPath  = path.join(sessionDir, "summary.json");
  const configPath   = path.join(sessionDir, "config.json");

  // ---- Internal state ----

  let missionCounter = 0;
  const missions = new Map(); // missionId -> mission object

  const summary = {
    sessionId,
    missionsReceived:  0,
    missionsCompleted: 0,
    missionsFailed:    0,
    runtimeRejections: 0,
  };

  // ---- Initialise static files ----

  const config = {
    sessionId,
    maxIterations:     maxIterations     ?? null,
    model:             model             ?? "unknown",
    startedAt:         new Date().toISOString(),
  };

  try { writeJSON(configPath, config);   } catch {}
  try { writeJSON(missionsPath, []);     } catch {}
  try { writeJSON(summaryPath, summary); } catch {}

  // ---- Core append ----

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
   * Returns the missionId to carry through the rest of the mission.
   */
  function startMission(request) {
    missionCounter++;
    const missionId  = toMissionId(missionCounter);
    const startedAt  = new Date().toISOString();

    missions.set(missionId, {
      missionId,
      request,
      status:  "running",
      reply:   null,
      startedAt,
      endedAt: null,
      steps:   0,
    });

    summary.missionsReceived++;
    logEvent("mission_received", { request }, missionId);
    return missionId;
  }

  /*
   * Call after each Executor tool call, before execution.
   * rawName = tool name as returned by the model
   * mappedName = internal action name after actionMapper
   * params = tool parameters (thought field already stripped)
   * thought = the thought field content
   */
  function logExecutorAction(missionId, { rawName, mappedName, params, thought }) {
    const m = missions.get(missionId);
    if (m) m.steps++;

    logEvent("executor_raw_action", {
      name:   rawName,
      params,
      thought,
    }, missionId);

    if (rawName !== mappedName) {
      logEvent("executor_mapped_action", {
        from: rawName,
        to:   mappedName,
      }, missionId);
    }
  }

  /*
   * Call when rulesValidator.js rejects an action.
   */
  function logActionRejected(missionId, actionName, reason) {
    summary.runtimeRejections++;
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
   */
  function endMission(missionId, status, reply) {
    const m = missions.get(missionId);
    if (!m) return;

    m.status  = status;
    m.reply   = reply;
    m.endedAt = new Date().toISOString();

    if (status === "completed") summary.missionsCompleted++;
    else                        summary.missionsFailed++;

    logEvent(
      status === "completed" ? "mission_completed" : "mission_failed",
      { reply, steps: m.steps },
      missionId
    );

    flushMissions();
    flushSummary();
  }

  /*
   * Call on process exit to close the session cleanly.
   */
  function endSession() {
    logEvent("session_ended", {
      totalMissions: missionCounter,
      durationMs:    Date.now() - new Date(config.startedAt).getTime(),
    });
    flushMissions();
    flushSummary();
  }

  // Log session start
  logEvent("session_started", { sessionId, model: config.model });

  return {
    sessionId,
    sessionDir,
    logEvent,
    startMission,
    logExecutorAction,
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
    sessionDir: null,
    logEvent:          noop,
    startMission:      () => "m_0000",
    logExecutorAction: noop,
    logActionRejected: noop,
    logObservation:    noop,
    logFinalReply:     noop,
    endMission:        noop,
    endSession:        noop,
  };
}