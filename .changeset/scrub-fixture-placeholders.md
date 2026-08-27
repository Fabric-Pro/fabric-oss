---
"fabric-app": patch
---

Normalize test-fixture emails and filesystem paths to reserved RFC 2606 placeholders ahead of the public-repo flip.

Pre-public-flip content scrub. The publication scanner (`scan-publication.mjs`) flags any email address outside a small sanctioned set, and any Unix or Windows user-home-shaped filesystem path, as a possible real identifier. This sweep addressed every file the scanner flagged for those two finding types.

Emails (98 flagged files):
- 80 files fixed — non-sanctioned fixture domains (`x.com`, `test.com`, `b.com`, `company.com`, `acme.com`, `fabric.dev`, `fabric.so`, `fabric.io`, `db.internal`, etc.) rewritten to `example.com` / `example.org` / `example.net` or a `.example`/`.invalid` TLD, verified against the scanner's actual `isSanctionedEmail` logic rather than guessed. Distinctness between two fixture parties (e.g. a cross-tenant-leak test, a multi-domain admin-email-list test) is preserved by giving them two different reserved domains. Attacker/negative-case addresses (`evil.com`) became `evil.example` — still unambiguously hostile, still scanner-clean.
- 18 files left unchanged — genuine real-world content with no sanctioned path available: the literal AI-attribution trailer a hook exists to detect, a couple of real infra hostnames a security check keys off literally, real GitHub/GitLab SSH clone syntax and setup docs, an upstream skill author's real address, and a small number of live runtime mail-sender defaults that are actual application behavior, not fixtures. Rewriting any of these would either break the thing under test or misrepresent real infrastructure or an external service's own documented address.

Home/user paths (44 flagged files):
- 8 files fixed — arbitrary test fixtures (a working-directory string, a stack-trace repo root, a Windows-vs-Unix fingerprint comparison) moved to `/tmp/...`, with no behavioral meaning lost.
- 1 file mandatory-fixed — `packages/database/scripts/run-10-e2e-cycles.sh` carried a real contributor's Windows checkout and temp-cookie path; both are now derived (`git rev-parse --show-toplevel`, `${TMPDIR:-/tmp}`), overridable via `E2E_REPO_ROOT` / `E2E_COOKIE_JAR`.
- 35 files left unchanged — real container-user home directories set up in three Dockerfiles, plus (the majority) a scanner false-positive class: oRPC route literals and doc examples under the app's users-resource REST namespace structurally match the tool's Windows-user-home regex even though they are HTTP paths, not filesystem paths — including real third-party API paths (Clerk, Zendesk, Notion) that must not change.

Also fixed five files the scanner reported as binary because of raw non-UTF-8 bytes hiding in otherwise-clean source: a stray latin-1 `§` in two `.csproj` comments, a raw `0x1F` field-delimiter byte in a rate-limit hash template literal, a raw ZIP-magic `0x03 0x04` pair in an E2E buffer assertion, and a raw NUL in a null-byte-strip test — all replaced with their escape-sequence equivalents (`\x1f`, `\x03\x04`, `\0`) so the bytes produced at runtime are unchanged but the source is valid UTF-8.

All edited test files were run per-package and pass; the six database integration suites that require a live Postgres (`authority-policy`, `frames`, `frame-sharing`, `frame-templates`, `rls-isolation`, `rls/incident-tables`) were type-checked clean but could not execute end-to-end in this environment — pre-existing constraint, unrelated to this change. Every edited file was independently re-verified against the actual scan-publication.mjs script.

Four of the edited files still carry one pre-existing, deliberately-untouched finding each after this sweep (the same "real content, no sanctioned path" and "REST-path false positive" categories above, just landing on a file this sweep also touched for an unrelated fixture on a different line): the three mirrored `e2e-testing` skill docs (their in-page REST route example) and the GitLab integration test (its real SSH clone-URL fixture on a separate line from the one this sweep fixed).
