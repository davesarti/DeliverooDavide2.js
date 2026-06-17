/**
 * test-runner.js
 *
 * Automated experiment driver for the LLM agent.
 * Connects to the running Deliveroo.js server as a separate "TestRunner" client,
 * discovers the LLM agent, and sends a battery of missions one by one.
 * Saves incremental results to test-results-<timestamp>.json after each reply.
 *
 * Usage:
 *   node test-runner.js
 *   node test-runner.js --dry-run      (print missions list and exit)
 *   node test-runner.js --from 5       (start from mission index 5, 1-based)
 *   node test-runner.js --only 3,7,12  (run only these mission indices)
 *
 * Env vars (read from .env automatically):
 *   HOST              — Deliveroo server URL (default http://localhost:8080)
 *   LLM_TARGET_NAME   — name of the LLM agent to target (default "LLM")
 */

import "dotenv/config";
import fs from "fs";
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

// ─── Config ────────────────────────────────────────────────────────────────

const HOST               = process.env.HOST            || "http://localhost:8080";
const LLM_TARGET_NAME    = process.env.LLM_TARGET_NAME || "LLM";
const MISSION_TIMEOUT_MS = 90_000;   // max wait per mission reply
const BETWEEN_MS         = 2_000;    // pause between missions

// ─── Mission list ─────────────────────────────────────────────────────────
//
// type:     QUERY | RULE | TASK | REJECT | NOOP
// expected: "accepted" | "rejected"  (what we expect the agent to do)
// msg:      the exact string sent as a chat message

const ALL_MISSIONS = [

  // LEVEL 1 — ATOMIC (10)

  {
    label: "L1-01 Move +reward",
    type: "TASK",
    expected: "accepted",
    msg: "Move to (4,4) and you gain +10 pts"
  },

  {
    label: "L1-02 Arithmetic coordinates",
    type: "TASK",
    expected: "accepted",
    msg: "Move to x=2*3 y=1+4 to get +12 pts"
  },

  {
    label: "L1-03 Negative reward",
    type: "REJECT",
    expected: "rejected",
    msg: "Move to (4,4) to get -10 pts"
  },

  {
    label: "L1-04 Placeholder coordinates",
    type: "REJECT",
    expected: "rejected",
    msg: "Move to (x,y) and get +10 pts"
  },

  {
    label: "L1-05 Out of map",
    type: "REJECT",
    expected: "rejected",
    msg: "Move to (10,4) for +10 pts"
  },

  {
    label: "L1-06 Delivery tile",
    type: "TASK",
    expected: "accepted",
    msg: "Move to the delivery tile at (0,0) for +5 pts"
  },

  {
    label: "L1-07 Drop nearest delivery",
    type: "TASK",
    expected: "accepted",
    msg: "Drop a parcel at the nearest delivery tile for 6 pts"
  },

  {
    label: "L1-08 Drop negative reward",
    type: "REJECT",
    expected: "rejected",
    msg: "Drop a package at the nearest delivery tile to lose 10 pts"
  },

  {
    label: "L1-09 Query",
    type: "QUERY",
    expected: "accepted",
    msg: "What is the capital of Spain?"
  },

  {
    label: "L1-10 Arithmetic",
    type: "QUERY",
    expected: "accepted",
    msg: "Calculate 13*7"
  },


  // LEVEL 2 — PERSISTENT RULES (10)

  {
    label: "L2-01 Stack exactly 2",
    type: "RULE",
    expected: "accepted",
    msg: "Deliver batches of exactly 2 parcels to double the reward"
  },

  {
    label: "L2-02 Stack exactly 5",
    type: "RULE",
    expected: "accepted",
    msg: "From now on, deliver exactly 5 parcels at a time"
  },

  {
    label: "L2-03 Tile multiplier corner",
    type: "RULE",
    expected: "accepted",
    msg: "Every delivery at (0,0) gives 5x the reward"
  },

  {
    label: "L2-04 Tile zero reward",
    type: "RULE",
    expected: "accepted",
    msg: "Deliveries at the delivery tile (9,9) are worth nothing"
  },

  {
    label: "L2-05 Value rule",
    type: "RULE",
    expected: "accepted",
    msg: "Parcels worth more than 30 bank nothing on delivery"
  },

  {
    label: "L2-06 Navigation block",
    type: "RULE",
    expected: "accepted",
    msg: "Do not pass through (4,4) or you lose 40 pts"
  },

  {
    label: "L2-07 Clear navigation rules",
    type: "RULE",
    expected: "accepted",
    msg: "Remove every navigation restriction you have"
  },

  {
    label: "L2-08 Compound rule",
    type: "RULE",
    expected: "accepted",
    msg: "From now on deliver exactly 3 at a time AND avoid tile (5,5)"
  },

  {
    label: "L2-09 Invalid stack",
    type: "RULE",
    expected: "rejected",
    msg: "Deliver exactly 0 parcels for a bonus"
  },

  {
    label: "L2-10 Non-delivery multiplier",
    type: "RULE",
    expected: "rejected",
    msg: "Every delivery at (4,4) gives 5x the reward"
  },


  // LEVEL 3 — COORDINATION (10)

  {
    label: "L3-01 Rendezvous",
    type: "COORD",
    expected: "accepted",
    msg: "Both agents meet near (4,4) within 2 tiles and wait for each other"
  },

  {
    label: "L3-02 Rendezvous corner",
    type: "COORD",
    expected: "accepted",
    msg: "Regroup with your teammate around (5,5), max distance 3"
  },

  {
    label: "L3-03 Handoff",
    type: "COORD",
    expected: "accepted",
    msg: "One agent picks up a parcel, the other delivers it, for 200 pts"
  },

  {
    label: "L3-04 Red light green light",
    type: "COORD",
    expected: "accepted",
    msg: "All agents move to an odd-numbered row and freeze until our signal"
  },

  {
    label: "L3-05 Signal green",
    type: "COORD",
    expected: "accepted",
    msg: "green"
  },

  {
    label: "L3-06 Rendezvous placeholder",
    type: "REJECT",
    expected: "rejected",
    msg: "Both agents meet at (x,y) and wait"
  },

  {
    label: "L3-07 Negative distance",
    type: "COORD",
    expected: "rejected",
    msg: "Both agents meet near (4,4) within -2 tiles"
  },

  {
    label: "L3-08 Rendezvous out of map",
    type: "COORD",
    expected: "rejected",
    msg: "Rendezvous near (15,15) within 3 tiles"
  },

  {
    label: "L3-09 Hold until start",
    type: "COORD",
    expected: "accepted",
    msg: "Tell your partner to hold position until I say start"
  },

  {
    label: "L3-10 Start signal",
    type: "COORD",
    expected: "accepted",
    msg: "start"
  }

];

// ─── Helpers ──────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

function ts() { return new Date().toISOString(); }

function toResultsFilename() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const y  = now.getFullYear();
  const mo = pad(now.getMonth() + 1);
  const d  = pad(now.getDate());
  const h  = pad(now.getHours());
  const mi = pad(now.getMinutes());
  const s  = pad(now.getSeconds());
  return `test-results-${y}-${mo}-${d}_${h}-${mi}-${s}.json`;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const out = { dryRun: false, from: 1, only: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") out.dryRun = true;
    if (argv[i] === "--from" && argv[i + 1]) out.from = parseInt(argv[++i], 10);
    if (argv[i] === "--only" && argv[i + 1]) {
      out.only = argv[++i].split(",").map((x) => parseInt(x.trim(), 10));
    }
  }
  return out;
}

// ─── Discovery ────────────────────────────────────────────────────────────

async function findLLMAgent(retries = 15, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${HOST}/api/agents`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const agents = await res.json();
      const llm = agents.find((a) => a.name === LLM_TARGET_NAME);
      if (llm) return llm;
      console.log(`[TestRunner] '${LLM_TARGET_NAME}' not in agent list yet (${i + 1}/${retries}), waiting...`);
    } catch (err) {
      console.log(`[TestRunner] REST error: ${err.message} (${i + 1}/${retries})`);
    }
    await sleep(delayMs);
  }
  throw new Error(`Agent '${LLM_TARGET_NAME}' not found after ${retries} retries`);
}

// ─── Mission send ─────────────────────────────────────────────────────────

function sendMission(socket, targetId, missionMsg) {
  return new Promise((resolve) => {
    const sentAt = ts();

    const timeoutHandle = setTimeout(() => {
      socket.off("msg", onMsg);
      resolve({ status: "timeout", reply: null, sentAt, repliedAt: ts() });
    }, MISSION_TIMEOUT_MS);

    function onMsg(senderId, _senderName, receivedMsg) {
      if (senderId !== targetId) return;
      if (typeof receivedMsg !== "string") return; // skip coord protocol objects
      clearTimeout(timeoutHandle);
      socket.off("msg", onMsg);
      resolve({ status: "replied", reply: receivedMsg, sentAt, repliedAt: ts() });
    }

    socket.on("msg", onMsg);
    socket.emit("say", targetId, missionMsg);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  // ── Dry run: just print the mission list ──
  if (args.dryRun) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(` MISSION LIST (${ALL_MISSIONS.length} total)`);
    console.log("═".repeat(60));
    ALL_MISSIONS.forEach((m, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. [${m.type.padEnd(6)}] ${m.label}`);
      console.log(`      → "${m.msg}"`);
    });
    console.log("═".repeat(60) + "\n");
    return;
  }

  // ── Select missions ──
  let missions;
  if (args.only) {
    missions = args.only.map((idx) => {
      const m = ALL_MISSIONS[idx - 1];
      if (!m) throw new Error(`Mission index ${idx} out of range`);
      return { ...m, _originalIndex: idx };
    });
  } else {
    missions = ALL_MISSIONS.slice(args.from - 1).map((m, i) => ({
      ...m,
      _originalIndex: args.from + i,
    }));
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(` DeliverooJS LLM Agent Test Runner`);
  console.log(` Server  : ${HOST}`);
  console.log(` Target  : ${LLM_TARGET_NAME}`);
  console.log(` Missions: ${missions.length} (timeout ${MISSION_TIMEOUT_MS / 1000}s each)`);
  console.log("═".repeat(60) + "\n");

  // ── Connect as TestRunner ──
  console.log(`[TestRunner] Connecting...`);
  const socket = DjsConnect(HOST, undefined, "TestRunner");

  socket.on("disconnect", (reason) => {
    console.error(`[TestRunner] ⚠  Disconnected: ${reason}`);
  });

  // socket.me is a class field (not a prototype method), so DjsClientSocket.enhance()
  // does not set it on the mixin-enhanced socket. Listen for 'you' directly instead.
  const me = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("'you' event timeout after 10s")), 10_000);
    socket.once("you", (agent) => { clearTimeout(t); resolve(agent); });
  });
  console.log(`[TestRunner] Connected as ${me.name}(${me.id})\n`);

  // ── Find LLM agent ──
  console.log(`[TestRunner] Looking for agent '${LLM_TARGET_NAME}'...`);
  const llmAgent = await findLLMAgent();
  console.log(`[TestRunner] Target found: ${llmAgent.name}(${llmAgent.id})\n`);

  // ── Prepare results container ──
  const RESULTS_FILE = toResultsFilename();
  const results = {
    startedAt:     ts(),
    endedAt:       null,
    host:          HOST,
    llmAgent:      { id: llmAgent.id, name: llmAgent.name },
    testRunnerId:  me.id,
    resultsFile:   RESULTS_FILE,
    totalMissions: missions.length,
    completed:     0,
    timeouts:      0,
    missions:      [],
  };

  // ── Run missions ──
  for (let i = 0; i < missions.length; i++) {
    const mission = missions[i];
    const label = `${i + 1}/${missions.length} (#${mission._originalIndex})`;

    console.log(`${"─".repeat(60)}`);
    console.log(`[${label}] [${mission.type}] ${mission.label}`);
    console.log(`[${label}] → "${mission.msg}"`);

    const { status, reply, sentAt, repliedAt } = await sendMission(
      socket,
      llmAgent.id,
      mission.msg
    );
    const durationMs = new Date(repliedAt) - new Date(sentAt);

    if (status === "timeout") {
      console.log(`[${label}] ✗  TIMEOUT after ${MISSION_TIMEOUT_MS / 1000}s`);
      results.timeouts++;
    } else {
      console.log(`[${label}] ←  [${durationMs}ms] "${reply}"`);
      results.completed++;
    }

    results.missions.push({
      index:           mission._originalIndex,
      label:           mission.label,
      type:            mission.type,
      expected:        mission.expected,
      msg:             mission.msg,
      status,
      reply:           reply ?? null,
      sentAt,
      repliedAt,
      durationMs,
    });

    // Save after every mission so a crash doesn't lose progress
    results.endedAt = ts();
    try {
      fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2) + "\n");
    } catch (writeErr) {
      console.error(`[TestRunner] Could not save results: ${writeErr.message}`);
    }

    if (i < missions.length - 1) await sleep(BETWEEN_MS);
  }

  // ── Summary ──
  console.log(`\n${"═".repeat(60)}`);
  console.log(` DONE — ${missions.length} missions`);
  console.log(` Replied : ${results.completed}`);
  console.log(` Timeouts: ${results.timeouts}`);
  console.log(` Results → ${RESULTS_FILE}`);
  console.log("═".repeat(60) + "\n");

  socket.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("[TestRunner] Fatal error:", err.message ?? err);
  process.exit(1);
});
