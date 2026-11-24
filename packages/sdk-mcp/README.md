# @fabricorg/sdk-mcp

Build an MCP server exposing the Fabric workspace catalog, integration tools
and built-in MCP App resources.

```sh
npm install @fabricorg/sdk-mcp @fabricorg/sdk
```

Pass a configured SDK client to `createFabricMcpServer({ fabric, name?, version? })`
and connect the returned server to your transport. The `FabricLike` type describes
the required client shape. The client supplies authentication, typically through
its `apiKey` option or `FABRIC_API_KEY`.

```ts
import { createFabric } from "@fabricorg/sdk";
import { createFabricMcpServer } from "@fabricorg/sdk-mcp";

const fabric = createFabric({ apiKey: process.env.FABRIC_API_KEY });
const server = createFabricMcpServer({ fabric });
```

For a ready-made stdio transport, call `runStdio()` from
`@fabricorg/sdk-mcp/stdio`. It builds the client from SDK environment defaults,
including `FABRIC_API_KEY`, `FABRIC_BASE_URL` and `FABRIC_ORG`. Keep stdout
available for MCP messages.

Use `FABRIC_MCP_APP_RESOURCES` and `readFabricMcpAppResource` to enumerate and
read built-in apps, `withFabricApp` to attach app metadata to a tool definition,
and `buildFabricVisualizePayload` to build a visualization payload. The package
also exports `FABRIC_BRAND` and `FABRIC_MARK_DATA_URI`.

See [MCP and CLI integration](../../docs/MCP_CLI_INTEGRATION.md).

[MIT](LICENSE).
