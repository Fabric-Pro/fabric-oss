---
"fabric-app": patch
---

An API key now stops working the moment its owner loses the access behind it, not only when they leave the organization

Fizzy #2380, second QA round. The first fix taught the key surfaces to read
membership live, so removing someone retired their key immediately. Demotion was
never considered: an ex-admin is still a member, and nothing downstream asked
what their role had become. A key minted while its owner was an admin kept
reading and exporting the organization's audit log from a plain Member account —
reproduced in QA on staging, and confirmed in the source, where the verifier asks
`isOrganizationMember` and stops there.

The rule is the same one the first fix stated: a key must never grant more than
the UI. What was missing is that the UI can narrow *after* the key is minted.

A scope is only escalation-prone when the permission behind it sits above the
role that may mint a key at all — `ORG_API_KEYS_CREATE` is member-and-up, so
anything a member already holds cannot be escalated onto a key. By the matrix
that is three of the twenty-one: `audit_log:read` and `audit_log:export`
(admin-only, the reproduced case) and `agents:execute` (member-and-up, so live on
a member-to-viewer demotion). Each now carries a second, live permission check
beside its existing scope check, following the two-gate idiom the MCP tools
already use.

Deliberately NOT done, and each for a reason worth keeping:

- No central narrowing of `scopes` inside `verifyOrganizationApiKey`. Both
  `hasScope` and `scopeSatisfied` treat `*` as a grant, and the MCP tool scopes
  are not in the organization vocabulary, so expanding a wildcard at the choke
  point would silently strip every MCP scope from every wildcard key — invisibly,
  exactly as the restored-session regression did.
- No gate on `agents:read` / `agents:stream`. Their permissions sit in the viewer
  set, which every role holds, so the check could refuse nobody.
- No creator filter on the external agent procedures. They resolve the tenant
  from the organization alone, but so does the in-app agents list, so the API
  already matches the UI; adding one would hide agents from a key whose owner can
  open them in a browser.

The refusal is a distinct `INSUFFICIENT_PERMISSION`, separate from
`INSUFFICIENT_SCOPE` and audited as such: the credential is intact and the
person's role changed, so re-minting the key would not help.
