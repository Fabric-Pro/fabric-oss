# Parlume and Databricks governance

What Databricks governance, including Unity Catalog, can and cannot enforce for Parlume's meeting answers today, and where it could fit later.

- **Audience**: Engineering, security reviewers and product owners
- **Owner**: Engineering team

Parlume answers in front of everyone in a meeting. The [governance policy](parlume-meetings.md#governance-policy) describes the rule Fabric enforces: Parlume answers only while everyone present is confirmed to read the project, every lookup runs with the access of the confirmed participant who asked, every meeting answer uses only what every project reader may see, a confidential part of a meeting is kept to its verified attendees and the project's managers, and Parlume explains and leaves when someone cannot be confirmed. This page assesses whether Databricks can take over or strengthen that enforcement.

This is a design assessment, not a runtime integration. The governance requirement asks Fabric to verify Databricks' capabilities and enforcement points before the final Unity Catalog integration tasks are defined, including how Fabric's direct database reads are governed. No Databricks call or setting was added for it.

## Where Parlume's data lives

| Data | Store | Who enforces access |
|---|---|---|
| Projects, features, documents, meeting transcripts and notes, Parlume sessions and requests | Fabric PostgreSQL | Fabric: project permissions and row-level security on tenant tables |
| Project knowledge search over documents and transcripts | Fabric's knowledge search | Fabric: project scope, and the exclusion of confidential series and raw Parlume transcripts |
| Project or agent Databricks knowledge (a Vector Search binding) | The customer's Databricks workspace | Databricks, for the binding integration's credential; Fabric, for which project or agent may use the binding |
| Model calls (Databricks model serving, AI Gateway) | Databricks | Databricks, for the endpoint's credential. A model call carries no right to project data |

None of the data Parlume answers from in a meeting is a Unity Catalog asset. Unity Catalog grants, row filters and column masks therefore cannot decide what Parlume says about it.

## What Databricks can enforce today

The one Parlume path that reaches Unity Catalog-governed data is a Databricks knowledge binding (`search_databricks_indexes`). The search runs with the credential of the integration that the project or agent binding names. Unity Catalog checks that credential's privileges, not those of the people in the meeting. It cannot tell Fabric that an attendee may read an index.

So, in a meeting, Parlume does not call Databricks knowledge tools. The meeting rule refuses every tool outside the project-read set, and these tools carry the `databricks-vector-search` source. This holds even while the inviter is alone in the meeting.

## What per-attendee Unity Catalog enforcement would need

1. **A Databricks identity for each attendee.** Each attendee would need an account in the customer's workspace, mapped from the Entra identity Fabric already confirms for the meeting.
2. **On-behalf-of tokens.** Fabric would need a token issued for each attendee, through a supported OAuth on-behalf-of flow with that attendee's consent. Fabric must never pass a user's identity as a header or prompt field.
3. **An intersection of answers.** A shared answer would need to query as every attendee, or as a group that contains only principals all attendees share, and use only results every query returned.
4. **The data in Unity Catalog.** Project records and meeting transcripts would have to be in Unity Catalog with matching row filters, and Fabric's PostgreSQL permissions would have to remain authoritative for everything else.

Items 1 and 2 do not exist in Fabric today. The [Databricks context platform](databricks-context-platform.md) design treats genuine per-user Unity Catalog enforcement as a separately qualified, customer-managed mode, not a default.

## Capabilities checked

Checked against the Azure Databricks documentation:

- **Row filters and column masks** restrict the rows and values a user sees at query time, on Unity Catalog tables, as SQL functions on a table or through attribute-based access control (ABAC) policies on governed tags. They decide by the identity that runs the query.
- **User authorization** (on-behalf-of the user) exists for Databricks Apps: Databricks forwards the user's own token, and Unity Catalog applies that user's grants, row filters and column masks. The token is valid only in the workspace the app runs in. A caller outside Databricks gets the same effect only with a token issued to that user through user-to-machine OAuth.
- **Lakehouse Federation** can register a PostgreSQL database as a read-only foreign catalog. The connection holds one credential that Databricks uses for every query, and Unity Catalog grants decide who may query the foreign catalog in Databricks.

## How Fabric's direct database reads are governed

Every Parlume path reads Fabric's own PostgreSQL directly: the turn, its project knowledge search, Fabric MCP's portal tools, the transcript, notes, suggestions and recap. None of these reads passes through Databricks, so Unity Catalog cannot decide them, and federating the database would not change that: Fabric's reads would still go straight to PostgreSQL, and a foreign catalog's queries would run with the connection's single credential, not the attendee's. These reads are governed in Fabric, which is the enforcement point:

| Policy rule | Fabric enforcement point |
|---|---|
| Lookups run as the person who asked | The turn's acting grant is minted for the asker; the worker checks the asker's project access again; project and agent knowledge are searched as the asker |
| Every recipient may see the answer | Each participant is confirmed at join and checked again before every turn; Parlume leaves when one cannot be confirmed |
| Shared answers hold only project-read content | `mayUseInMeeting` limits a turn to project-read tools |
| Confidential discussion stays with its readers | Confidential segments and sessions are filtered out of turns, the Parlume page, the context list, the transcript and the recap for anyone who is not a verified attendee or a project manager |
| Tenant isolation | Organization and project scoping on every query, with row-level security on tenant tables |

## Unity Catalog integration tasks

With these conclusions, the integration tasks are:

1. **Keep Databricks knowledge out of meetings** until task 3 is done. This is the current behaviour, enforced by `mayUseInMeeting`.
2. **Least-privilege binding credentials.** A project's Databricks knowledge binding should use a service principal whose grants, row filters and column masks expose only what every reader of the bound project may see. Fabric cannot verify this; the customer's workspace administrator owns it.
3. **Optional per-asker Databricks reads.** To let an answer use Databricks knowledge with the asker's own Unity Catalog access, Fabric would need an attendee-to-Databricks identity mapping, a user-to-machine OAuth consent per user, and a token store; the shared-answer rule would still need the answer to hold only what everyone present may see. This is a separate feature with its own approval.
4. **No Unity Catalog layer over Fabric's own tables.** Moving Fabric's project data into Unity Catalog, or federating it, does not govern Fabric's own reads and is not planned.

## Recommendation

- Keep Fabric's own checks as the enforcement point for meetings: confirmed project read for everyone present, lookups as the asker, a project-read ceiling on shared answers, confidential discussion kept to its readers, and departure when someone cannot be confirmed.
- Use Unity Catalog where the data is already Databricks-governed. A binding's credential should be a least-privilege principal whose grants cover only what every reader of the bound project may see. With that, a later change could allow project Databricks knowledge in meetings.
- Treat per-attendee Unity Catalog enforcement as a separate feature with its own approval, since it needs the identity and token work above.

## Limitations

- A project's Databricks knowledge is not available in a meeting.
- Model serving and AI Gateway policies govern model use and cost, not who may receive an answer.
- Fabric checks each attendee when they join, and checks their project read, and the asker's, again from its own database before each answer. Neither check asks Databricks.
- Unity Catalog cannot mark a meeting confidential or enforce who reads it: confidential discussion lives in Fabric's database.
