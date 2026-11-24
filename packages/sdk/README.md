# @fabricorg/sdk

TypeScript client for Fabric's REST API, with resources for projects, saved
agents, workflows, coding instructions and more.

## Install

```sh
npm install @fabricorg/sdk
# Or
pnpm add @fabricorg/sdk
```

## Client and authentication

`createFabric(options)` and `new FabricClient(options)` create the same client.
Supply an API key as `apiKey` or set `FABRIC_API_KEY` in the calling process.
The client sends it as a Bearer credential. Keep the key in server-side code
or a local script.

```ts
import { createFabric } from "@fabricorg/sdk";

const fabric = createFabric({
  apiKey: process.env.FABRIC_API_KEY,
  baseUrl: "https://example.com",
  org: "example-org",
});

const identity = await fabric.auth.whoami();
const projects = await fabric.projects.list();
```

| Option | Default or behavior |
| --- | --- |
| `apiKey` | `FABRIC_API_KEY`. A missing key throws `FabricAuthError`. |
| `baseUrl` | `FABRIC_BASE_URL`, then the default Fabric service. |
| `org` | `FABRIC_ORG`. The default organization slug. |
| `project` | `FABRIC_PROJECT`. The default project ID where the method accepts one. |
| `personal` | **Deprecated.** Personal context is retired. The client still reads `FABRIC_PERSONAL` (`1` or case-insensitive `true`) and throws `INVALID_CONTEXT` if an organization and personal context are both set. |
| `fetch` | Global `fetch`. Supply a compatible implementation to customize requests. |
| `timeoutMs` | 60,000 ms per attempt. |
| `retry` | `maxRetries` defaults to 2, `initialDelayMs` to 250, `multiplier` to 2, and `maxDelayMs` to 5,000. Set `maxRetries: 0` to disable retries. |
| `onEvent` | Optional callback for request, response, retry and error events. |
| `userAgent` | Optional `User-Agent` header. |
| `onUpgradeNotice` | Optional callback receiving the `X-Fabric-Cli-Upgrade` response header value when present. |

`withOrg(slug)`, `withProject(projectId)` and `withoutContext()` return new
clients. Use `withoutContext()` to clear organization and personal defaults
when the request's project determines its organization. Read the client’s
project default through `defaultProject`.

`withPersonal()` is **deprecated**. Personal context is retired. Use
`withOrg(slug)` for organization context, the only supported tenant context.

## Resources

The [SDK entry point](src/index.ts) also exports option, result and domain types.
The linked resource files define method signatures.

| Namespace | Methods |
| --- | --- |
| [`auth`](src/resources/auth.ts) | `whoami`, `listKeys`, `createKey`, `revokeKey` |
| [`orgs`](src/resources/orgs.ts) | `list` |
| [`projects`](src/resources/projects.ts) | `list`, `get`, `create`, `update`, `listCodeRepositories`, `listFeatures`, `getFeature`, `createFeature`, `updateFeature`, `assignFeature`, `listTasks`, `listDocuments`, `getDocument`, `createDocument`, `updateDocument`, `listInstructionSets`, `createInstructionSet`, `updateInstructionSet`, `deleteInstructionSet`, `getPluginName` |
| [`workflows`](src/resources/workflows.ts) | `list`, `get`, `trigger`, `getExecution`, `listExecutions`, `cancelExecution` |
| [`prompts`](src/resources/prompts.ts) | `list`, `get`, `create`, `update` |
| [`agents`](src/resources/agents.ts) | `list`, `get`, `invoke`, `invokeInstance`, `getInstanceExecution`, `execute` (**deprecated**, use `invoke`) |
| [`agentRuns`](src/resources/agent-runs.ts) | `search`, `list`, `get`, `cancel`, `getSchedule`, `setSchedule` |
| [`skills`](src/resources/skills.ts) | `list`, `get` |
| [`mcp`](src/resources/mcp.ts) | `listServers`, `listConfigs`, `getConfig`, `deleteConfig` |
| [`frames`](src/resources/frames.ts) | `list`, `get` |
| [`instructions`](src/resources/instructions.ts) | `getPublished`, `getRepositoryState`, `listRepositoryFiles`, `readRepositoryFiles`, `getRepositoryFile`, `resolveCheckout`, `createDownloadUrl`, `createFileDownloadUrls`, `createVersionFileDownloadUrls`, `submitRepositoryChange`, `submitChange`, `getProposalPullRequest`, `getOpenProposals`, `publishChange` |
| [`contexts`](src/resources/contexts.ts) | `linkedDocuments`, `linkWorkspaceDocument`, `unlinkWorkspaceDocument`, `readLinkedDocument`, `assemble`, `manifest`, `upsertSyncedFile`, `deleteSyncedFile`, `findMissingSyncedFiles`, `resetSyncedFiles` |
| [`contextQuality`](src/resources/context-quality.ts) | `inspectAgentResult`, `checkAgentResult`, `inspect`, `evaluate` |
| [`contextQuality.runs`](src/resources/context-quality.ts) | `capabilities`, `create`, `list`, `get`, `cancel`, `compare` |
| [`memory`](src/resources/memory.ts) | `getTargets`, `listFiles`, `getFile`, `createUploadUrls`, `submitWrite`, `getWrite` |
| [`workspaces`](src/resources/workspaces.ts) | `list`, `get`, `listDocuments`, `readDocument`, `query` |
| [`chats`](src/resources/chats.ts) | `list`, `get`, `create`, `rename`, `update`, `delete`, `sendMessage` |
| [`reports`](src/resources/reports.ts) | `listTemplates`, `getTemplate`, `listExecutions` |
| [`integrations`](src/resources/integrations.ts) | `list`, `[slug].call(operation, args)`, and vendor operation paths such as `slack.channels.list()`. Vendor packages add types for their paths. |
| [`channels`](src/resources/channels.ts) | `list`, `send` |
| [`approvals`](src/resources/approvals.ts) | `list`, `approve`, `deny` |
| [`knowledge`](src/resources/knowledge.ts) | `getProjectTypes`, `search` |

The root exports `planPluginFiles`, `pluginPathFor`, `projectRulePathFor` and
`PLUGIN_LEFT_OUT_REASONS` for coding-tool file mapping, plus
`DOCUMENT_ERROR_CODES` for document errors.

## Errors

- `FabricError` exposes `status`, optional `code` and optional structured `data`.
  Transport failures can use `NETWORK_ERROR` or `TIMEOUT`.
- `FabricAuthError` covers missing API keys and HTTP 401.
- `FabricForbiddenError` covers HTTP 403, including scope or access refusals.
- `FabricNotFoundError` covers HTTP 404.
- `FabricContextConflictError` exposes `conflict` for recognized synced-context
  file version conflicts (HTTP 409).

## Related references

- [Audit Log REST API](../../docs/audit-log/api.md) for direct HTTP calls.

## License

[MIT](LICENSE).
