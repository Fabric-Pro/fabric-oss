This package contains material derived from Corsair (Apache-2.0). Full repository notices: THIRD_PARTY_NOTICES.md in the source repository (https://github.com/Fabric-Pro/fabric-oss).

## Corsair (https://github.com/corsairdotdev/corsair)

Portions of this package are derived from Corsair, an open-source integration
layer for AI agents. Corsair is licensed under the **Apache License, Version 2.0**.

Copyright (c) Corsair contributors

Licensed under the Apache License, Version 2.0 (the "License"); you may not use
the derived files except in compliance with the License. The complete license
text is included in this package as `LICENSE-APACHE-2.0`, and may also be
obtained at:

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed
under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied. See the License for the
specific language governing permissions and limitations under the License.

### Files derived from Corsair

Each derived file carries a header pointing back to this notice.

| Fabric path | Upstream Corsair path | Notes |
|---|---|---|
| `packages/integrations-slack/src/index.ts` | `packages/slack/**` (endpoint surface + risk classifications) | Slim port: 8 most-used endpoints. Risk levels mirror Corsair's `endpointMeta`. Handlers are fabric-native HTTP wrappers, not corsair's `makeSlackRequest`. |
