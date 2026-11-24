# @fabricorg/integrations-notion

Adds typed Notion operations for pages, databases, blocks and search to `fabric.integrations.notion`.
The package exports `NotionIntegrationClient` and the runtime plugin `notionPlugin`.

```sh
npm install @fabricorg/sdk @fabricorg/integrations-notion
```

With Notion connected in Fabric, pass a Fabric API key to the SDK or set
`FABRIC_API_KEY`. Import this package to enable the SDK's vendor types.

```ts
import { createFabric } from "@fabricorg/sdk";
import "@fabricorg/integrations-notion";

const fabric = createFabric({ org: "example-org" });
const result = await fabric.integrations.notion.pages.get({ page_id: "example-page" });
```

When hosting `notionPlugin` with the integration runtime, supply a Notion bearer token
through the tenant's credential store. The plugin looks up `access_token`, `token`, `api_key` in that order.

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for Apache-2.0 attribution.
