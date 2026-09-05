---
"fabric-app": patch
---

Constrain the OAuth callback redirect target to a same-origin path so a caller-chosen returnUrl can no longer send the user off-site

Both generic OAuth callback routes (`/api/integrations/oauth/callback` and
`/api/integrations/[provider]/oauth/callback`) used `result.returnUrl` from
the HMAC-signed state as the non-popup fallback redirect without validating
it. The value is chosen by the caller at `start` time and only signed, so a
signed-in user could send themselves to any absolute URL after the provider
round-trip (low-severity open redirect, Fizzy #2370; surfaced by the CodeQL
js/incomplete-sanitization triage in Fizzy #2368).

Both routes now pass the value through `sanitizeReturnUrl`, which the
GitHub-specific route already applied. That helper now delegates to the
shared `safeRelativePath`, which also closes a tab-smuggling bypass in the
old prefix check ("/\t/host" parses as "//host" once the URL parser strips
the tab). Absolute URLs are rejected even when same-origin, so the three
callers that sent `window.location.href` (OAuthSettings, GitHubSettings,
ConnectionRequiredDialog) now send pathname + search + hash like the other
`start` callers already did; the GitHub one was silently falling back to the
settings page before this change.

Also fixes a pre-existing ordering bug in all three callback routes: the
`?oauth=`/`?github_oauth=` result parameters were appended after any
`#fragment` on the return path, so the settings return banner never saw them.
A small `appendQuery` helper now inserts them before the fragment.

Tests: sanitizer cases for same-origin absolute and control-character
smuggling; a route-level suite that pins both generic routes to the sanitizer.
