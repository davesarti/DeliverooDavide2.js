/**
 * test-runner.js
 *
 * Automated experiment driver for the LLM agent — LEVEL 1 ONLY.
 * Connects to the running Deliveroo.js server as a separate "TestRunner" client,
 * discovers the LLM agent, and sends a battery of atomic missions one by one.
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

const HOST = process.env.HOST || "http://localhost:8080";
const LLM_TARGET_NAME = process.env.LLM_TARGET_NAME || "LLM";
const MISSION_TIMEOUT_MS = 90_000;
const BETWEEN_MS = 2_000;

// ─── Mission list ─────────────────────────────────────────────────────────
//
// type:     QUERY | TASK | REJECT
// expected: "accepted" | "rejected"
// msg:      the exact string sent as a chat message
//
// LEVEL 1 ONLY:
// Atomic missions: move, drop, factual query, arithmetic query.

const ALL_MISSIONS = [
  // ── 1A: Move with POSITIVE reward → accept ──────────────────────────────
  {
    label: "L1-01: Move +reward (explicit coords)",
    type: "TASK",
    expected: "accepted",
    msg: "Move to (4,7) and you get +10pts",
  },
  {
    label: "L1-02: Move +reward (variant phrasing)",
    type: "TASK",
    expected: "accepted",
    msg: "Move to (2,3) to get +20 pts",
  },
  {
    label: "L1-03: Move +reward (go-to phrasing)",
    type: "TASK",
    expected: "accepted",
    msg: "Go to position (0,5) for +5 pts",
  },
  {
    label: "L1-04: Move +reward ('collect' phrasing)",
    type: "TASK",
    expected: "accepted",
    msg: "Move to (6,2) to collect a +8 pts reward",
  },

  // ── 1B: Move with NEGATIVE reward → reject ──────────────────────────────
  {
    label: "L1-05: Move -reward (exact PDF example)",
    type: "REJECT",
    expected: "rejected",
    msg: "Move to (4,7) to get -10pts",
  },
  {
    label: "L1-06: Move -reward ('lose' phrasing)",
    type: "REJECT",
    expected: "rejected",
    msg: "Move to (2,3) and lose 5 pts",
  },
  {
    label: "L1-07: Move -reward ('penalty' phrasing)",
    type: "REJECT",
    expected: "rejected",
    msg: "Go to (0,0) for a -20 pts penalty",
  },
  {
    label: "L1-08: Move -reward (large penalty)",
    type: "REJECT",
    expected: "rejected",
    msg: "Move to (5,5) and receive -30 pts",
  },

  // ── 1C: Arithmetic coordinates, positive reward → accept ────────────────
  {
    label: "L1-09: Move arithmetic coords (one side)",
    type: "TASK",
    expected: "accepted",
    msg: "Move to x=4*2 y=3 to get +15 pts",
  },
  {
    label: "L1-10: Move arithmetic coords (both sides)",
    type: "TASK",
    expected: "accepted",
    msg: "Move to x=(2+1) y=(1+3)*2 for +10 pts",
  },

  // ── 1D: Arithmetic coordinates, negative reward → reject ────────────────
  {
    label: "L1-11: Move arithmetic coords + negative reward (PDF example)",
    type: "REJECT",
    expected: "rejected",
    msg: "Move to x=4*2 y=(1+3)*3 to get -10pts",
  },

  // ── 1E: Placeholder coordinates → reject ────────────────────────────────
  {
    label: "L1-12: Move placeholder (x,y) (PDF example)",
    type: "REJECT",
    expected: "rejected",
    msg: "Move to (x,y) to get +10pts",
  },
  {
    label: "L1-13: Move placeholder (x1,y1) phrasing",
    type: "REJECT",
    expected: "rejected",
    msg: "Go to position (x1,y1) for +20 pts",
  },
  {
    label: "L1-14: Move placeholder with question mark",
    type: "REJECT",
    expected: "rejected",
    msg: "Move to x=? y=4 for +5 pts",
  },

  // ── 1F: Drop package at spatial delivery tile, positive reward → accept ─
  {
    label: "L1-15: Drop at leftmost tile +reward (PDF example)",
    type: "TASK",
    expected: "accepted",
    msg: "Drop a package at the leftmost delivery tile to get 5pt",
  },
  {
    label: "L1-16: Drop at rightmost tile +reward",
    type: "TASK",
    expected: "accepted",
    msg: "Drop a package at the rightmost delivery tile to get +10 pts",
  },
  {
    label: "L1-17: Drop at topmost tile +reward",
    type: "TASK",
    expected: "accepted",
    msg: "Drop a package at the topmost delivery tile to get +8 pts",
  },
  {
    label: "L1-18: Drop at nearest tile, no explicit reward",
    type: "TASK",
    expected: "accepted",
    msg: "Drop a package at the nearest delivery tile",
  },

  // ── 1G: Drop with negative reward → reject ───────────────────────────────
  {
    label: "L1-19: Drop at leftmost tile -reward (PDF example)",
    type: "REJECT",
    expected: "rejected",
    msg: "Drop a package at the leftmost delivery tile to get -10pt",
  },
  {
    label: "L1-20: Drop at bottommost tile -reward",
    type: "REJECT",
    expected: "rejected",
    msg: "Deliver a parcel to the bottommost delivery tile for -5 pts",
  },

  // ── 1H: Reward = 0 → not negative, accept ────────────────────────────────
  {
    label: "L1-21: Drop at topmost tile reward=0 (not negative)",
    type: "TASK",
    expected: "accepted",
    msg: "Drop a package at the topmost delivery tile to get 0 pts",
  },

  // ── 1I: Factual queries ───────────────────────────────────────────────────
  {
    label: "L1-22: Query — capital of Italy (PDF example)",
    type: "QUERY",
    expected: "accepted",
    msg: "What is the capital of Italy?",
  },
  {
    label: "L1-23: Query — moon landing",
    type: "QUERY",
    expected: "accepted",
    msg: "Who was the first person to walk on the moon?",
  },
  {
    label: "L1-24: Query — WWII end year",
    type: "QUERY",
    expected: "accepted",
    msg: "In what year did World War II end?",
  },
  {
    label: "L1-25: Query — boiling point",
    type: "QUERY",
    expected: "accepted",
    msg: "What is the boiling point of water in Celsius?",
  },

  // ── 1J: Arithmetic queries ────────────────────────────────────────────────
  {
    label: "L1-26: Arithmetic — basic multiplication (PDF example)",
    type: "QUERY",
    expected: "accepted",
    msg: "Calculate 5*5",
  },
  {
    label: "L1-27: Arithmetic — power",
    type: "QUERY",
    expected: "accepted",
    msg: "Calculate 2^10",
  },
  {
    label: "L1-28: Arithmetic — parentheses",
    type: "QUERY",
    expected: "accepted",
    msg: "How much is (3+4)*5?",
  },
  {
    label: "L1-29: Arithmetic — percentage",
    type: "QUERY",
    expected: "accepted",
    msg: "How much is 15% of 240?",
  },
  {
    label: "L1-30: Arithmetic — sqrt + factorial",
    type: "QUERY",
    expected: "accepted",
    msg: "Calculate sqrt(225) + 3!",
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function ts() {
  return new Date().toISOString();
}

function toResultsFilename() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const y = now.getFullYear();
  const mo = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const h = pad(now.getHours());
  const mi = pad(now.getMinutes());
  const s = pad(now.getSeconds());
  return `test-results-level1-${y}-${mo}-${d}_${h}-${mi}-${s}.json`;
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
      console.log(
        `[TestRunner] '${LLM_TARGET_NAME}' not in agent list yet (${i + 1}/${retries}), waiting...`
      );
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
      if (typeof receivedMsg !== "string") return;
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

  if (args.dryRun) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(` LEVEL 1 MISSION LIST (${ALL_MISSIONS.length} total)`);
    console.log("═".repeat(60));
    ALL_MISSIONS.forEach((m, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. [${m.type.padEnd(6)}] ${m.label}`);
      console.log(`      → "${m.msg}"`);
    });
    console.log("═".repeat(60) + "\n");
    return;
  }

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
  console.log(` DeliverooJS LLM Agent Test Runner — LEVEL 1 ONLY`);
  console.log(` Server  : ${HOST}`);
  console.log(` Target  : ${LLM_TARGET_NAME}`);
  console.log(` Missions: ${missions.length} (timeout ${MISSION_TIMEOUT_MS / 1000}s each)`);
  console.log("═".repeat(60) + "\n");

  console.log(`[TestRunner] Connecting...`);
  const socket = DjsConnect(HOST, undefined, "TestRunner");

  socket.on("disconnect", (reason) => {
    console.error(`[TestRunner] Disconnected: ${reason}`);
  });

  const me = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("'you' event timeout after 10s")), 10_000);
    socket.once("you", (agent) => {
      clearTimeout(t);
      resolve(agent);
    });
  });

  console.log(`[TestRunner] Connected as ${me.name}(${me.id})\n`);

  console.log(`[TestRunner] Looking for agent '${LLM_TARGET_NAME}'...`);
  const llmAgent = await findLLMAgent();
  console.log(`[TestRunner] Target found: ${llmAgent.name}(${llmAgent.id})\n`);

  const RESULTS_FILE = toResultsFilename();
  const results = {
    startedAt: ts(),
    endedAt: null,
    host: HOST,
    llmAgent: { id: llmAgent.id, name: llmAgent.name },
    testRunnerId: me.id,
    resultsFile: RESULTS_FILE,
    totalMissions: missions.length,
    completed: 0,
    timeouts: 0,
    missions: [],
  };

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
      console.log(`[${label}] TIMEOUT after ${MISSION_TIMEOUT_MS / 1000}s`);
      results.timeouts++;
    } else {
      console.log(`[${label}] ← [${durationMs}ms] "${reply}"`);
      results.completed++;
    }

    results.missions.push({
      index: mission._originalIndex,
      label: mission.label,
      type: mission.type,
      expected: mission.expected,
      msg: mission.msg,
      status,
      reply: reply ?? null,
      sentAt,
      repliedAt,
      durationMs,
    });

    results.endedAt = ts();
    try {
      fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2) + "\n");
    } catch (writeErr) {
      console.error(`[TestRunner] Could not save results: ${writeErr.message}`);
    }

    if (i < missions.length - 1) await sleep(BETWEEN_MS);
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(` DONE — ${missions.length} level-1 missions`);
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