---
"fabric-app": patch
---

Bump @modelcontextprotocol/sdk from 1.26 to 1.30 so CopilotKit react-core 1.70 runs on the MCP SDK floor it declares

Fizzy #2384. `@copilotkit/react-core` 1.70.1 (and the `@modelcontextprotocol/ext-apps`
1.7.5 it depends on) declare a peer dependency of `@modelcontextprotocol/sdk@^1.29.0`,
but the repo resolved 1.26.0 and pnpm never warned. The reason is the root
`pnpm.overrides` entry `@modelcontextprotocol/sdk@^1.10.0 -> ^1.26.0`: it matches the
`^1.29.0` peer range and rewrote it to `^1.26.0` in the lockfile, so the unmet-peer check
compared against the rewritten range and passed. React-core's MCP-apps client was
therefore running three minors below its declared floor at runtime, with nothing
surfacing it at install, type-check, or test time.

The four workspaces that declare the SDK (`apps/web`, `packages/mcp`, `packages/sdk-mcp`,
`agents/langchain/data-analyst`) and the root override move to `^1.30.0` together so pnpm
keeps a single SDK in the tree. The lockfile was hand-edited: 1.30.0 has the same
dependency ranges as 1.26.0 (only `@hono/node-server` widened, and the resolved 1.19.17
still satisfies it), so the SDK snapshot keeps its existing sub-dependency versions and
the diff is the SDK identity change alone, proven with
`pnpm install --frozen-lockfile --lockfile-only`.

Upstream changes between 1.26.0 and 1.30.0 are all v1.x backports: OAuth discovery
caching and `scopes_supported` default (1.27/1.28), rejection of plain JSON Schema
objects as tool `inputSchema` (1.28), typings exports and capability extensions (1.29),
Content-Type validation by parsed media type, SSE keep-alive frames from the Streamable
HTTP server transport, a stdio buffer limit, and formatted zod issues (1.30).
