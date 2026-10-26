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

### Inter typeface (https://github.com/rsms/inter)

The Proposal export embeds Inter 4.1 in the PDFs it prints (Fizzy #2946). The
font files are bundled unmodified, with their licence, in
`packages/temporal/src/lib/proposal-export/fonts/`:
`Inter-Regular.woff2`, `Inter-SemiBold.woff2`, `Inter-Bold.woff2` and
`Inter-ExtraBold.woff2`, from the `web/` folder of the official v4.1 release.

Copyright (c) 2016 The Inter Project Authors. Licensed under the **SIL Open
Font License, Version 1.1**; the full licence text is
`packages/temporal/src/lib/proposal-export/fonts/LICENSE.txt`.

### Proposal export runtime dependencies

The Temporal worker's Proposal export (Fizzy #2946) depends on these packages,
installed from npm and not modified:

| Package | Licence | Use |
|---|---|---|
| `beautiful-mermaid` | MIT | Renders Mermaid diagrams to SVG in the worker, as the live page does |
| `elkjs` (a dependency of `beautiful-mermaid`) | EPL-2.0 | Diagram layout |
| `docx` | MIT | Writes the Word export |
| `sharp` | Apache-2.0 | Checks and re-encodes stored images and logos |
| `libvips` (bundled in `sharp`'s prebuilt `@img/sharp-libvips-*` binaries) | LGPL-3.0-or-later | Image decoding and encoding, dynamically linked and unmodified |

### Decision Replay dashboard embed (`@databricks/aibi-client`)

The project Usage tab's AI outcomes view embeds a Databricks AI/BI dashboard
with `@databricks/aibi-client` 1.2.1 (Fizzy #3324), installed from npm and not
modified. It is loaded only when Decision Replay is on and the embed renders,
and it is used only with Databricks Services. It is not open source: Databricks
licenses it under the "DB license" below, which permits redistribution provided
each recipient receives a copy of this license. Its text, from the package's
`LICENSE` file (trailing whitespace removed):

    # DB license

    **Definitions.**

    Agreement: The agreement between Databricks, Inc., and you governing the use of the Databricks Services, as that term is defined in the Master Cloud Services Agreement (MCSA) located at www.databricks.com/legal/mcsa.

    Licensed Materials: The source code, object code, data, and/or other works to which this license applies.

    **Scope of Use.** You may not use the Licensed Materials except in connection with your use of the Databricks Services pursuant to the Agreement. Your use of the Licensed Materials must comply at all times with any restrictions applicable to the Databricks Services, generally, and must be used in accordance with any applicable documentation. You may view, use, copy, modify, publish, and/or distribute the Licensed Materials solely for the purposes of using the Licensed Materials within or connecting to the Databricks Services. If you do not agree to these terms, you may not view, use, copy, modify, publish, and/or distribute the Licensed Materials.

    **Redistribution.** You may redistribute and sublicense the Licensed Materials so long as all use is in compliance with these terms. In addition:

    * You must give any other recipients a copy of this License;
    * You must cause any modified files to carry prominent notices stating that you changed the files;
    * You must retain, in any derivative works that you distribute, all copyright, patent, trademark, and attribution notices, excluding those notices that do not pertain to any part of the derivative works; and
    * If a "NOTICE" text file is provided as part of its distribution, then any derivative works that you distribute must include a readable copy of the attribution notices contained within such NOTICE file, excluding those notices that do not pertain to any part of the derivative works.

    You may add your own copyright statement to your modifications and may provide additional license terms and conditions for use, reproduction, or distribution of your modifications, or for any such derivative works as a whole, provided your use, reproduction, and distribution of the Licensed Materials otherwise complies with the conditions stated in this License.

    **Termination.** This license terminates automatically upon your breach of these terms or upon the termination of your Agreement. Additionally, Databricks may terminate this license at any time on notice. Upon termination, you must permanently delete the Licensed Materials and all copies thereof.


    **DISCLAIMER; LIMITATION OF LIABILITY.**

    THE LICENSED MATERIALS ARE PROVIDED “AS-IS” AND WITH ALL FAULTS. DATABRICKS, ON BEHALF OF ITSELF AND ITS LICENSORS, SPECIFICALLY DISCLAIMS ALL WARRANTIES RELATING TO THE LICENSED MATERIALS, EXPRESS AND IMPLIED, INCLUDING, WITHOUT LIMITATION, IMPLIED WARRANTIES, CONDITIONS AND OTHER TERMS OF MERCHANTABILITY, SATISFACTORY QUALITY OR FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. DATABRICKS AND ITS LICENSORS TOTAL AGGREGATE LIABILITY RELATING TO OR ARISING OUT OF YOUR USE OF OR DATABRICKS’ PROVISIONING OF THE LICENSED MATERIALS SHALL BE LIMITED TO ONE THOUSAND ($1,000) DOLLARS.  IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE LICENSED MATERIALS OR THE USE OR OTHER DEALINGS IN THE LICENSED MATERIALS.
