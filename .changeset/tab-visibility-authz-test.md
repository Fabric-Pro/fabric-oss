---
"fabric-app": patch
---

Cover the authorization branch that decides who may hide a project tab for everyone.

Fizzy #1837 follow-up. The tab-visibility write carries
`requireProjectPermission(PROJECT_UPDATE)` as its decorator, but the handler applies a stricter
`PROJECT_SETTINGS_EDIT` check of its own, because reshaping navigation for every member is a
settings decision rather than an ordinary project edit. The repo's permission-coverage ratchet
is a static check for the presence of a decorator, so it could not see that second check —
which left the branch separating an ordinary member from a project admin with no test at all.

Seven cases now pin it: a member holding PROJECT_UPDATE but not PROJECT_SETTINGS_EDIT is
refused, a caller with no resolvable access is refused, an editor and an owner are allowed, and
an override that would hide Overview or Settings is rejected even for an owner. Removing the
guard turns the two refusal cases red, so they fail without it rather than merely alongside it.

Test-only; no runtime behaviour changes.
