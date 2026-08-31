---
"fabric-app": patch
---

Close the last protocol path that ran in no organization

Both MCP entry points excluded the browser-session branch from the no-null-organization rule, on the stated grounds that a null meant personal context and personal context was still somewhere a browser could legitimately be. Each note said retargeting belonged with the removal of personal context. This is that removal, and FR4 admits no code path that resolves to no organization.

A session naming none now asks the same shared resolver the API-key branch asks: it resolves where the answer is unambiguous, and refuses otherwise rather than falling through to no tenant. Sessions are seeded with an organization at creation now, so what reaches this path is the residue — a session minted before that shipped, or a caller whose membership was ambiguous enough that the seeding declined to guess.
