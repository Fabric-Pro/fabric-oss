# @fabricorg/integrations-gmail

Adds typed Gmail operations for messages and labels to `fabric.integrations.gmail`.
The package exports `GmailIntegrationClient` and the runtime plugin `gmailPlugin`.

```sh
npm install @fabricorg/sdk @fabricorg/integrations-gmail
```

With Gmail connected in Fabric, pass a Fabric API key to the SDK or set
`FABRIC_API_KEY`. Import this package to enable the SDK's vendor types.

```ts
import { createFabric } from "@fabricorg/sdk";
import "@fabricorg/integrations-gmail";

const fabric = createFabric({ org: "example-org" });
const result = await fabric.integrations.gmail.messages.list({ maxResults: 10 });
```

When hosting `gmailPlugin` with the integration runtime, supply a Google OAuth access token
through the tenant's credential store. The plugin looks up `access_token`, `token` in that order.

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for Apache-2.0 attribution.
