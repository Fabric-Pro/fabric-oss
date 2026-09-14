---
"fabric-app": patch
---

Make a deleted organization unreachable by URL, and name the organization in the deletion confirmation email and page

Fizzy #2462 follow-up, from staging QA of the flow.

**The subject shipped a raw ICU placeholder.** The confirmation mail arrived
titled `Confirm deleting {organizationName}`. `getTemplate` only runs a subject
through a translator when the template exports `resolveSubject`; otherwise it
assigns `translations.mail.<id>.subject` as a raw string. Neither
organization-deletion template exported one, and both subjects interpolate — so
the reminder mail, the last warning before a tenant is destroyed permanently,
was leaking two placeholders and never carried its purge date into the inbox
list at all. Both templates now resolve their subject. The doc-comments in both
asserted the opposite ("exporting one would make the subject the only
untranslatable line") and are corrected; `resolveSubject` receives a bound
translator, so it is exactly as translatable as the body.

**`template-i18n-coverage.test.ts` could not have caught it.** Its guard matches
a leaked `mail.<template>.<key>` path — the shape a *missing* key degrades to.
A key that exists and is read raw keeps its braces instead, so the file stayed
green while the broken subject shipped. Added a second, independent net for an
uninterpolated ICU argument, pinned to the subject — the only field
`getTemplate` reads raw. A body string with unpassed values degrades to the key
path instead (checked against the real translator), so the existing net already
covers it and a body assertion could only ever false-positive on legitimate copy
containing a brace. Verified by disabling both resolvers and watching it fail on
the exact string from the bug report.

**A deleted organization was still reachable by direct link.** Its URL rendered
a complete, working-looking app shell — sidebar, organization name, logo, theme
colour — while every data read underneath was refused at tenant resolution. Some
panels showed "Failed to load"; others were indistinguishable from empty,
because a failed list query and an empty one render the same. Nothing anywhere
said the organization had been deleted, and nothing offered the way back.

The schema already states the intended contract — a deactivated organization
keeps every row it owns and "is made unreachable by REFUSING it at tenant
resolution", which is why none of its ~168 related tables carries a liveness
predicate. The oRPC tenant middleware honoured it; two server-side resolvers did
not, and both are fixed together because neither is safe alone:

- `getActiveOrganization` now refuses a deleted organization before it resolves
  anything, which also closes the guest fallback beneath it — that path queries
  by slug with no liveness predicate, so a project-scoped guest could reach the
  shell of an organization its own members were already locked out of.
- `getOrganizationList` now filters deleted organizations out. This is what
  `/app` routes on (`lastActiveOrganizationId ?? activeOrganizationId ??
  organizations.at(0)`), so leaving them in both dropped people back into a
  deleted workspace at sign-in and would have turned the new redirect into an
  infinite bounce.

The slug layout redirects to `/app` rather than 404ing: this app's 404 is the
marketing one, whose only exit is the public homepage, whereas `/app` routes to
another organization or to `/new-organization`, which carries the restore banner
naming the organization and the button that brings it back.

**The confirmation page never said which organization.** It read "Delete this
organization?" — on the last screen before everything in a tenant goes dark,
for someone who may own several. The page now resolves the name from the token
server-side via `fetchOrganizationNameForDeletionToken`, mirroring the
`fetchChatAgentSelectionForUser` pattern, and falls back to the unnamed copy
when the token is expired, already spent, or was issued to another account.

Two properties that the new `readOrganizationDeletionToken` had to preserve, both
pinned by tests: it does not consume the token — the page renders for the mail
scanners the click requirement exists to defend against, and a consuming read
would burn the link before the owner ever clicked it — and it reports every
failure identically, so the page cannot become an oracle that tells the holder
of a leaked link which way it was invalid, or what it points at.
