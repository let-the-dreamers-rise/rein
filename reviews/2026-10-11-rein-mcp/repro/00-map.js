// Day-1 map: what the server advertises. Prints every tool, its description
// and its arguments, as the calling model sees them.
//   node 00-map.js
const { start } = require("./harness");

(async () => {
  const s = start();
  const init = await s.init();
  console.log("server:", s.server);
  console.log("initialize ->", JSON.stringify(init.result));
  // The server echoes whatever protocol version the client asks for.
  const odd = await s.rpc("initialize", { protocolVersion: "1999-01-01" });
  console.log("initialize with protocolVersion 1999-01-01 ->", odd.result.protocolVersion);
  const list = await s.rpc("tools/list", {});
  for (const t of list.result.tools) {
    console.log(`\n## ${t.name}`);
    console.log(t.description);
    console.log("args:", JSON.stringify(t.inputSchema.properties), "required:", JSON.stringify(t.inputSchema.required || []));
    console.log("annotations:", JSON.stringify(t.annotations || null));
  }
  console.log(`\n${list.result.tools.length} tools`);
  s.stop();
})();
