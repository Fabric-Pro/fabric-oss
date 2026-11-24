# @fabricorg/integrations-slack

Adds typed Slack operations for messages, channels and users to `fabric.integrations.slack`.
The package exports `SlackIntegrationClient` and the runtime plugin `slackPlugin`.

```sh
npm install @fabricorg/sdk @fabricorg/integrations-slack
```

With Slack connected in Fabric, pass a Fabric API key to the SDK or set
`FABRIC_API_KEY`. Import this package to enable the SDK's vendor types.

```ts
import { createFabric } from "@fabricorg/sdk";
import "@fabricorg/integrations-slack";

const fabric = createFabric({ org: "example-org" });
const result = await fabric.integrations.slack.channels.list({ limit: 10 });
```

When hosting `slackPlugin` with the integration runtime, supply a Slack bearer token
through the tenant's credential store. The plugin looks up `token`, `access_token`, `bot_token` in that order.

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for Apache-2.0 attribution.
