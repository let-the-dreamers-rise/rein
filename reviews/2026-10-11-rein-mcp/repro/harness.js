// Minimal MCP stdio client used by every reproduction in this folder.
//
// Spawns the Rein MCP server exactly as a client would (node <server> [args]),
// sends newline-delimited JSON-RPC, and collects replies by id. No MCP SDK, no
// model in the loop: each repro plays the part of a fully compromised agent
// that can send any tool arguments it likes.
//
//   REIN_SERVER   server entry point (default: the shipped plugin bundle)
//   REIN_REPO     repo root (default: this repo)
const { spawn } = require("child_process");
const path = require("path");

const REPO = process.env.REIN_REPO || path.resolve(__dirname, "../../..");
const SERVER = process.env.REIN_SERVER || path.join(REPO, "plugin/server/rein-mcp.cjs");

function start({ args = ["--sandbox"], env = {}, preload = null, cleanEnv = true } = {}) {
  // Start from a clean environment so no REIN_* from the reviewer's shell leaks in.
  const base = cleanEnv ? { PATH: process.env.PATH, HOME: process.env.HOME } : { ...process.env };
  const nodeArgs = preload ? ["--require", preload, SERVER, ...args] : [SERVER, ...args];
  const child = spawn(process.execPath, nodeArgs, { env: { ...base, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  let buf = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const w = waiting.get(msg.id);
      if (w) {
        waiting.delete(msg.id);
        w(msg);
      }
    }
  });
  child.stderr.on("data", (d) => (stderr += d));
  let next = 1;
  const rpc = (method, params, { timeoutMs = 60000 } = {}) =>
    new Promise((resolve) => {
      const id = next++;
      const t = setTimeout(() => {
        waiting.delete(id);
        resolve({ id, timeout: true });
      }, timeoutMs);
      waiting.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const call = async (name, args, opts) => {
    const r = await rpc("tools/call", { name, arguments: args }, opts);
    if (r.timeout) return { timeout: true };
    if (r.error) return { rpcError: r.error };
    const text = r.result.content[0].text;
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { isError: r.result.isError, text, json };
  };
  const init = () => rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "rein-review-harness", version: "1" } });
  const stop = () => child.kill("SIGKILL");
  return { child, rpc, call, init, stop, stderr: () => stderr, server: SERVER };
}

module.exports = { start, REPO, SERVER };
