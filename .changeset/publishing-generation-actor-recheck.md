---
"fabric-app": patch
---

Publishing generation now re-checks the permission the API gate actually checked, so an invited project editor can use the five generation tabs

The five Publishing Suite generation activities re-validated the actor at the
point of use with `isCurrentOrgMember`. The gate that authorized the run is
`requireProjectPermission(PUBLISHING_TOPIC_UPDATE)`, whose precedence is
owner -> active ProjectMember -> org role. Organization membership is the LAST
of those three, so an actor authorized by the second — a project-scoped editor
who is not a member of the host organization, which is precisely what the
project-invite flow creates — passed the gate, had a `GENERATING` draft row
written for them, and was then refused by the activity. Deterministically, on
every attempt, since Phase 2B. The stored failure reason said they were "no
longer an org member", which was never true of them.

A re-check that asks a different question than the gate is not a second opinion.
It is a second policy, and the two disagree by construction.

Replaced by `checkPublishingGenerationActor` (`@repo/database`), which resolves
the same ladder the gate uses — including the middleware's `source === "owner"`
short-circuit, without which a personal-project owner is refused permissions
outside the OWNER set — and returns a decision rather than a permission set, so
`@repo/temporal` does not have to take a dependency on the permission
vocabulary. `assertGenerationActorAuthorized` maps that decision to the two
existing failure codes and, new, logs the reason before throwing.

Three things worth knowing beyond the fix itself.

**The tenant half is defence in depth, not a fix.** The activities also never
verified that the project still belonged to the organization the run was queued
under. This was reported as a live transfer race; it is not. `PROJECT_TRANSFER`
is declared in the permission vocabulary and consumed by nothing, no production
query writes `Project.organizationId` after creation, and the only code that
moves a project between organizations is test fixtures. The comparison is added
because the suite's other tenancy guard (`assertProjectTenantTuple`) already
makes it, and a transfer feature landing later should find the hole closed. Its
tests prove the comparison is wired, and are labelled so nobody cites them as
evidence of a defect.

**Every failed generation displayed the wrong reason.** Temporal delivers an
activity throw as `ActivityFailure`, whose own `.message` is the generic
"Activity task failed"; the reason lives on `.cause`. All five workflows read
`error.message`, so that one string was stored on the draft and rendered in the
panel for a revoked actor, a malformed bound prompt and a provider outage alike.
They now use the repo's cause-chain walk and log the error class alongside it.
This also changes a non-`Error` rejection from "Unknown error" to the value
itself, which is the walk's documented fallback.

**A comment that justified the old guard was inverted.** All five file headers
said org model resolution "PREFERS the actor's personal provider". Measured,
`getAiProviderApiKey` tries the organization's configured provider FIRST and
falls back to a personal one only when the organization has none. The risk a
late check would allow is therefore spend against the organization's key, not
the actor's — a stronger reason for the guard than the one written down, and one
that also means an invited editor's runs are billed to the organization, as they
already are for AI chat and agent execution through the same project role.

Guarded by a family-wide check keyed on the SYMPTOM rather than on a name
pattern: every activity that still calls `isCurrentOrgMember` must be classified
with a written reason, and every publishing generation activity must call the
shared assertion BEFORE anything resolves a model. Both are AST checks — the
first version searched source text and reported the replacement module itself,
because its doc comment names the helper it replaced.

Not included, deliberately: folding `canEditProject` and `canCreateProjectStory`
onto the new resolver. They are two more copies of the same ladder and should
be, but they have thirteen production call sites including the collaborative
editing token issuer and the MCP gateway's write authorization, and that does
not belong in a security fix.
