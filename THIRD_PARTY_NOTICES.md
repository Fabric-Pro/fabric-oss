# Third-Party Notices

This file lists third-party software included in or derived by this repository,
along with their licenses and required attribution. Maintained alongside the
ported source files. A CI check enforcing these headers is planned for the
public-repository CI.

---

## Corsair (https://github.com/corsairdotdev/corsair)

Portions of this repository are derived from Corsair, an open-source integration
layer for AI agents. Corsair is licensed under the **Apache License, Version 2.0**.

Copyright (c) Corsair contributors

Licensed under the Apache License, Version 2.0 (the "License"); you may not use
the derived files except in compliance with the License. You may obtain a copy
of the License at:

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed
under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied. See the License for the
specific language governing permissions and limitations under the License.

### Files derived from Corsair

Each derived file carries a header pointing back to this notice. The runtime
package (`@fabricorg/integrations-runtime`) ports the contract — types,
permission matrix, and policy evaluation — but reimplements the executor,
webhook processor, and stores natively for Fabric (Corsair's runtime is
Kysely- and KEK-bound, which doesn't fit the existing portal connector store).

| Fabric path | Upstream Corsair path | Notes |
|---|---|---|
| `packages/integrations-runtime/src/types.ts` | `packages/corsair/core/plugins/index.ts` (permission types, endpoint meta shape) | Simplified: flat endpoint records instead of deeply nested generic trees |
| `packages/integrations-runtime/src/permissions.ts` | `packages/corsair/core/permissions/index.ts` (matrix + `parseDurationMs`) | Verbatim matrix and duration parser; no DB-backed namespace |
| `packages/integrations-slack/src/index.ts` | `packages/slack/**` (endpoint surface + risk classifications) | Slim port: 8 most-used endpoints. Risk levels mirror Corsair's `endpointMeta`. Handlers are fabric-native HTTP wrappers, not corsair's `makeSlackRequest`. |
| `packages/integrations-github/src/index.ts` | `packages/github/**` | Slim port: 9 endpoints across repos / issues / pullRequests |
| `packages/integrations-gmail/src/index.ts` | `packages/gmail/**` | Slim port: 7 endpoints (messages + labels) |
| `packages/integrations-linear/src/index.ts` | `packages/linear/**` | Slim port: 7 endpoints translated to focused GraphQL operations |
| `packages/integrations-notion/src/index.ts` | `packages/notion/**` | Slim port: 9 endpoints (pages, databases, blocks, search) |

### Derived-file header (required on every ported file)

```ts
// Portions of this file are derived from Corsair (https://github.com/corsairdotdev/corsair)
// Original work © Corsair contributors. Licensed under Apache-2.0.
// Modifications © TechFabric LLC. Licensed under MIT (see the containing package's LICENSE).
// See THIRD_PARTY_NOTICES.md at the repository root for full attribution.
```

---

## Other third-party notices

(Add additional sections as new third-party code is incorporated.)
