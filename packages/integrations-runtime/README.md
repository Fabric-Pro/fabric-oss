# @fabricorg/integrations-runtime

Host Fabric integration plugins with permission checks, approval handling and
webhook dispatch.

```sh
npm install @fabricorg/integrations-runtime
```

Define a plugin with `defineIntegration` and `endpoint`, register it in
`IntegrationRegistry`, and invoke its operations through `IntegrationExecutor`.
The executor uses an injected `CredentialStore` keyed by tenant ID and plugin
slug. The plugin defines the credential fields it needs. The host also
supplies an `ApprovalStore`. The in-memory stores are for tests and local
development.

```ts
import {
  defineIntegration,
  endpoint,
  IntegrationExecutor,
  IntegrationRegistry,
  MemoryApprovalStore,
  MemoryCredentialStore,
} from "@fabricorg/integrations-runtime";

const registry = new IntegrationRegistry();
registry.register(defineIntegration({
  slug: "example",
  name: "Example",
  endpoints: {
    "status.get": endpoint(async () => ({ ok: true }), { riskLevel: "read" }),
  },
}));

const credentials = new MemoryCredentialStore();
credentials.set("example-org", "example", {});
const executor = new IntegrationExecutor({
  registry,
  credentials,
  approvals: new MemoryApprovalStore(),
});
const result = await executor.call({
  tenantId: "example-org",
  pluginSlug: "example",
  endpoint: "status.get",
});
```

`WebhookProcessor` dispatches inbound events using registered webhook
definitions. The package also exports `evaluatePermission`, `PERMISSION_MATRIX`
and `parseDurationMs`.

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for Apache-2.0 attribution.
