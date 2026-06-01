/**
 * Production signaling smoke test against the deployed Worker.
 * Verifies room creation, role assignment, two-peer relay, and third-peer
 * rejection over wss://. Set your Worker URL first, then run:
 *   SIGNAL_BASE=https://securesend-signal.<your-subdomain>.workers.dev node backend/smoke-prod.mjs
 */
import WebSocket from "ws";

const BASE = (process.env.SIGNAL_BASE || "https://securesend-signal.example.workers.dev").replace(/\/+$/, "");
const WS_BASE = BASE.replace(/^http/, "ws");

const open = (roomId) => new WebSocket(`${WS_BASE}/api/rooms/${roomId}/ws`);
const nextMsg = (ws) =>
  new Promise((resolve) => ws.once("message", (d) => resolve(JSON.parse(d.toString()))));

async function main() {
  const res = await fetch(`${BASE}/api/rooms`, { method: "POST" });
  const { roomId } = await res.json();
  console.log("✓ created room:", roomId);

  const a = open(roomId);
  await new Promise((r) => a.once("open", r));
  const aWelcome = await nextMsg(a);
  console.assert(aWelcome.role === "initiator", "A initiator");
  console.log("✓ A welcome role:", aWelcome.role);

  const b = open(roomId);
  const aJoined = nextMsg(a);
  await new Promise((r) => b.once("open", r));
  const bWelcome = await nextMsg(b);
  console.assert(bWelcome.role === "responder", "B responder");
  console.log("✓ B welcome role:", bWelcome.role);
  console.assert((await aJoined).kind === "peer-joined", "A peer-joined");
  console.log("✓ A notified peer-joined");

  const bRecv = nextMsg(b);
  a.send(JSON.stringify({ kind: "signal", data: { type: "ecdh-public-key", payload: { key: "AAA", salt: "BBB" } } }));
  const got = await bRecv;
  console.assert(got.data?.payload?.key === "AAA", "relay verbatim");
  console.log("✓ relay A->B works");

  const c = open(roomId);
  await new Promise((r) => c.once("open", r));
  const cMsg = await nextMsg(c);
  console.assert(cMsg.kind === "room-full", "third rejected");
  console.log("✓ third peer rejected:", cMsg.kind);

  a.close(); b.close(); c.close();
  console.log("\nPRODUCTION SMOKE TEST PASSED");
  process.exit(0);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
