/**
 * Manual integration test for the signaling server.
 * Verifies: room creation, role assignment, relay between two peers, and
 * third-peer rejection. Run while `wrangler dev` is up on :8787.
 */
import WebSocket from "ws";

const BASE = "http://localhost:8787";
const WS_BASE = "ws://localhost:8787";

// The signaling server now enforces the ALLOWED_ORIGINS allow-list on the
// WebSocket upgrade. wrangler dev uses the production var (your Pages origin),
// so we present that Origin like a real browser.
// Override with ALLOWED_ORIGIN=... if your local var differs (e.g. "*").
const ORIGIN = process.env.ALLOWED_ORIGIN || "https://your-app.pages.dev";

function open(roomId) {
  const ws = new WebSocket(`${WS_BASE}/api/rooms/${roomId}/ws`, {
    headers: { Origin: ORIGIN },
  });
  // Buffer incoming messages so a fast `welcome` (sent immediately on connect)
  // is never lost to a not-yet-attached listener. nextMsg() drains this queue.
  ws._queue = [];
  ws._waiters = [];
  ws.on("message", (d) => {
    const msg = JSON.parse(d.toString());
    const waiter = ws._waiters.shift();
    if (waiter) waiter(msg);
    else ws._queue.push(msg);
  });
  return ws;
}

function nextMsg(ws) {
  if (ws._queue.length > 0) return Promise.resolve(ws._queue.shift());
  return new Promise((resolve) => ws._waiters.push(resolve));
}

async function main() {
  // 1. Create a room.
  const res = await fetch(`${BASE}/api/rooms`, { method: "POST" });
  const { roomId } = await res.json();
  console.log("✓ created room:", roomId);

  // 2. Peer A joins -> should be initiator.
  const a = open(roomId);
  await new Promise((r) => a.once("open", r));
  const aWelcome = await nextMsg(a);
  console.assert(aWelcome.kind === "welcome" && aWelcome.role === "initiator", "A is initiator");
  console.log("✓ peer A welcome:", aWelcome);

  // 3. Peer B joins -> should be responder, A should get peer-joined.
  const b = open(roomId);
  const aPeerJoinedP = nextMsg(a);
  await new Promise((r) => b.once("open", r));
  const bWelcome = await nextMsg(b);
  console.assert(bWelcome.kind === "welcome" && bWelcome.role === "responder", "B is responder");
  console.log("✓ peer B welcome:", bWelcome);
  const aPeerJoined = await aPeerJoinedP;
  console.assert(aPeerJoined.kind === "peer-joined", "A notified of join");
  console.log("✓ peer A got peer-joined");

  // 4. Relay: A sends a signal, B receives it verbatim.
  const bRecvP = nextMsg(b);
  a.send(JSON.stringify({ kind: "signal", data: { type: "ecdh-public-key", payload: { key: "AAA", salt: "BBB" } } }));
  const bRecv = await bRecvP;
  console.assert(bRecv.kind === "signal" && bRecv.data.type === "ecdh-public-key" && bRecv.data.payload.key === "AAA", "relay works");
  console.log("✓ relay A->B:", bRecv);

  // 5. Third peer is rejected.
  const c = open(roomId);
  await new Promise((r) => c.once("open", r));
  const cMsg = await nextMsg(c);
  console.assert(cMsg.kind === "room-full", "third peer rejected");
  console.log("✓ third peer rejected:", cMsg);

  // 6. A disallowed Origin is rejected at the WebSocket upgrade (403), unless
  //    the server is running with a wildcard ALLOWED_ORIGINS ("*", dev).
  if (ORIGIN !== "*") {
    const bad = new WebSocket(`${WS_BASE}/api/rooms/${roomId}/ws`, {
      headers: { Origin: "https://evil.example" },
    });
    const rejected = await new Promise((resolve) => {
      bad.once("open", () => resolve(false)); // should NOT open
      bad.once("error", () => resolve(true)); // upgrade refused
    });
    console.assert(rejected, "disallowed origin rejected at upgrade");
    console.log("✓ disallowed origin rejected at WS upgrade");
    try {
      bad.close();
    } catch {
      /* never opened */
    }
  }

  a.close();
  b.close();
  c.close();
  console.log("\nALL INTEGRATION CHECKS PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("INTEGRATION TEST FAILED:", e);
  process.exit(1);
});
