---
"fabric-app": patch
---

Test fixtures now use example.com placeholder emails instead of ad-hoc short domains.

Internal context (not published):

Mechanical sweep of `*@e.co` mock-session emails to `*@example.com` across 18 test files
(17 in packages/api, 1 in packages/database, 25 substitutions). The short domain is not a
sanctioned placeholder, so any publication pipeline that screens for unsanctioned email
addresses flags these files whenever they appear in a changed set. No assertion depended on
the literal values; the touched suites pass unchanged (363 + 20 tests).
