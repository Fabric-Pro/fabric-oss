# @fabricorg/integrations-linear

Adds typed Linear operations for issues, teams and the current user to `fabric.integrations.linear`.
The package exports `LinearIntegrationClient` and the runtime plugin `linearPlugin`.

```sh
npm install @fabricorg/sdk @fabricorg/integrations-linear
```

With Linear connected in Fabric, pass a Fabric API key to the SDK or set
`FABRIC_API_KEY`. Import this package to enable the SDK's vendor types.

```ts
import { createFabric } from "@fabricorg/sdk";
import "@fabricorg/integrations-linear";

const fabric = createFabric({ org: "example-org" });
const result = await fabric.integrations.linear.issues.list({ first: 10 });
```

When hosting `linearPlugin` with the integration runtime, supply a Linear credential valid for the API
through the tenant's credential store. The plugin looks up `access_token`, `token`, `api_key` in that order.

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for Apache-2.0 attribution.
