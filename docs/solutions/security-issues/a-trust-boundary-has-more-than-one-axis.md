---
title: "A trust boundary has more than one axis"
date: 2026-08-03
category: security-issues
problem_type: security_issue
component: api_procedures
applies_when:
  - "Moving a decision from the client to the server because the client's copy can be stale or forged"
  - "Adding a procedure that returns tenant-scoped content the caller names by id"
  - "Directing a reviewer or an implementer at one specific hole in an authorization path"
  - "Adding a tenant-keyed read to a procedure that did not previously make one"
tags: [authorization, multi-tenant, permissions, code-review, trust-boundary, prompts]
audience: engineers hardening an authorization path, and anyone briefing a reviewer
owner: web app team
---

# A trust boundary has more than one axis

## Context

Fizzy #2048 moved a decision out of the browser: which AI prompt template a work item's action runs. The browser had been reading the item's type from its own cache, deriving the template name, and asking the server to resolve that name. A server procedure accepted the type and the template name as free input and had no way to check either, so an item converted from a different surface regenerated with the previous type's template.

The fix was a new procedure that takes the work item id and reads the type off the stored row.

## What went wrong

The implementer was briefed with one specific concern, stated precisely: `resolveOrganizationId` returns the caller-supplied organization id verbatim with no membership check, so a new endpoint returning tenant-scoped prompt text must add an explicit membership check. They did exactly that, correctly, with the guard placed before any read.

Review then found two authorization defects in the same change. Neither was the one named.

**The permission level, not the tenant.** The new procedure required `PROJECT_READ`. Every comparable sibling — three `resolve-*` procedures in the same directory — required `STORY_UPDATE`, and the endpoint being replaced required an organization-level `PROMPT_READ`. The new endpoint was therefore weaker than both the local convention and the thing it replaced: a project Viewer could now read prompt-catalog content that had been gated more strictly. The membership check was present and correct; it answers "which tenant", not "which role".

**The neighbour that gained a tenant-keyed read.** A different unit of the same change added a prompt-binding lookup to a sibling procedure, passing the organization id through. That procedure has no membership check — and had not needed a conspicuous one, because it never previously performed an organization-keyed read of tenant-authored content. The change converted a dormant omission into a live one, in the file next door to the one carrying a comment that warns about exactly this.

## The rule

Naming a hole directs attention *at* it and *away from everything else*. An implementer given a precise threat closes that threat and reports success honestly — the brief becomes the boundary of the audit.

So when hardening an authorization path, enumerate the axes before briefing anyone:

- **Tenant** — can the caller reach another tenant's data? (Membership, not just a resolved id.)
- **Role** — is the permission level right for what is returned, and does it match the siblings and whatever it replaces?
- **Object** — can the caller pair an id they own with one they do not? Does the lookup scope by every id in the request, or only some?
- **Blast radius of the id** — a by-id lookup that scopes only by tenant returns anything in that tenant, not only the thing related to the request.
- **Neighbours** — did this change give an *existing* procedure a new tenant-keyed read it never made before? The guard that was merely absent becomes a hole.

## How to catch it

Compare against siblings mechanically, not from memory. One command answered the first defect:

```bash
grep -n "requireProjectPermission(Permissions\." \
  packages/api/modules/projects/procedures/stories/resolve-*.ts
```

Three siblings said `STORY_UPDATE`; the new one said `PROJECT_READ`. The convention is discoverable in seconds and does not depend on anyone remembering it.

For the neighbour case, the question is whether a *read* was added, not whether a *file* was changed:

```bash
# does this procedure now perform a tenant-keyed read, and does it verify the tenant?
grep -n "organizationId" <procedure> | head
grep -c "requireOrganizationMembership" <procedure>
```

## Related

The same change also demonstrated the parallel-implementation failure this rule protects: a template decision made in the browser is a copy of the routing rule, and copies drift. See [[work-item-kind]] in `CONCEPTS.md` — the stored row is the only authority, and a caller that names a type is stating a claim, not a fact.
