# @fabricorg/integrations-github

Adds typed GitHub operations for repositories, issues and pull requests to `fabric.integrations.github`.
The package exports `GithubIntegrationClient` and the runtime plugin `githubPlugin`.

```sh
npm install @fabricorg/sdk @fabricorg/integrations-github
```

With GitHub connected in Fabric, pass a Fabric API key to the SDK or set
`FABRIC_API_KEY`. Import this package to enable the SDK's vendor types.

```ts
import { createFabric } from "@fabricorg/sdk";
import "@fabricorg/integrations-github";

const fabric = createFabric({ org: "example-org" });
const result = await fabric.integrations.github.repos.get({ owner: "example-org", repo: "example-repo" });
```

When hosting `githubPlugin` with the integration runtime, supply a GitHub bearer token
through the tenant's credential store. The plugin looks up `token`, `access_token`, `pat` in that order.

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for Apache-2.0 attribution.
