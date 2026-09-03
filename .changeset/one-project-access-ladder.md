---
"fabric-app": patch
---

Collapse the three copies of the project-authorization ladder in projects.ts into one

`resolveProjectAccess`, `canEditProject` and `canCreateProjectStory` each walked
the same ladder — personal-project owner, then active `ProjectMember` row, then
organization role — in three byte-identical implementations differing only by
the permission constant they ended on.

Two copies of an authorization policy is the defect that let a project editor
through `requireProjectPermission(PUBLISHING_TOPIC_UPDATE)` and then refused
them at a runtime re-check that asked about organization membership instead.
Three copies is the same defect with more places to fix and more chances to fix
only some of them. Both helpers now delegate to `resolveProjectAccess` through
one private `projectPermissionHolds`.

Behaviour-preserving by construction: the delegation keeps the
`source === "owner"` short-circuit, which is what the previous unconditional
`return true` on the owner path amounted to. Two things worth stating plainly
rather than implying:

- A negative control showed that **removing that short-circuit breaks no test**.
  For the two permissions these helpers ask about it is currently equivalent to
  the plain `hasPermission` check, because the OWNER project role holds both.
  The difference only appears for a permission outside that set, and nothing
  asks these helpers for one. It is kept because it is `resolveProjectAccess`'s
  documented caller contract and matches what the gate does — the comment now
  says exactly that instead of claiming it is load-bearing here.
- `canCreateProjectStory` had **no precedence coverage at all**. That is the
  shape the gap took: one of two identical copies was tested, so the tested one
  was right and nothing said anything about the other. Six cases now cover it —
  owner, per-project demotion over the org role, org fallback, expired row,
  stranger, missing project.

A negative control reintroducing the org-first ordering in
`canCreateProjectStory` fails exactly the demoted-org-admin case, which is the
bug the ladder exists to prevent and the one that shipped on every non-oRPC
surface before issue #705.

Call sites are unchanged: three Next.js route handlers (document lock, collab
verify, collab token) and the MCP gateway's platform tools.
