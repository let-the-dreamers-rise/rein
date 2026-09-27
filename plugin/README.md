# Rein for Claude

The Rein MCP server, bundled into one file (`server/rein-mcp.cjs`) that runs
on a bare `node` 18+ with nothing installed, and wrapped for Claude Code and
Claude Desktop. It starts in sandbox mode: a funded Rein account on a private
chain inside the server, so there is nothing to configure and no real money.

The readable source is [`mcp/`](../mcp) in this repo;
[`scripts/build-bundle.js`](../scripts/build-bundle.js) builds this folder
from it, and CI fails if the committed files differ from a fresh build.

| | |
|---|---|
| `server/rein-mcp.cjs` | the MCP server, ethers and the sandbox EVM in one file |
| `.mcp.json`, `.claude-plugin/` | the Claude Code plugin |
| `commands/try.md` | `/rein:try`, one honest payment then five attempts to drain the account |
| `commands/scan.md` | `/rein:scan 0x…`, the policy an agent wallet's own history supports and what it could lose |
| [`../dist/rein.mcpb`](../dist/rein.mcpb) | the same server as a Claude Desktop extension: download it and double-click |

Install instructions are in [QUICKSTART.md](../QUICKSTART.md).
