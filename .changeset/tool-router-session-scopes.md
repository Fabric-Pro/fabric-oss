---
"fabric-app": patch
---

A tool-router session now reaches no further than the API key that minted it, and only into organizations its owner belongs to

Fizzy #2380, QA round 2. Two gaps on a route that never participated in the
scope model at all, which is why scope testing everywhere else could not have
found them.

`verifyUserApiKey`'s scope argument is optional and its check is guarded by it,
so calling the function bare skips the check entirely. The session mint called
it bare, and nothing downstream of `validateSession` read scopes either. Any
valid personal key — whatever it was issued to do — minted a session that could
send Slack messages and write to Drive. Minting now requires `mcp:read`, the
key's scopes travel on the session, and `tools/call` requires `mcp:write`. The
scopes are stored rather than re-read per request because here the session id
IS the credential presented later, unlike `/mcp`, where the key accompanies
every request.

`organizationId` was taken verbatim from the request body, stamped into the
session and handed to `fetchCredentialsByProvider`, which selects an
organization's stored integration credentials on `organizationId` alone with no
membership predicate of its own. Naming someone else's organization was the
whole attack: their GitHub, Slack and Drive tokens. Membership is checked
before the id is stored, for the browser branch too, since
`activeOrganizationId` is a stored field that outlives the membership it points
at.
