# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Fabric AI, please report it responsibly.

**Do not open a public issue for security vulnerabilities.**

### How to Report

Email: **security@fabric.pro**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

| Stage | Timeline |
|-------|----------|
| Acknowledgment | Within 48 hours |
| Initial assessment | Within 5 business days |
| Fix development | Depends on severity |
| Public disclosure | After fix is deployed |

### What to Expect

1. We will acknowledge your report within 48 hours
2. We will investigate and assess the severity
3. We will work on a fix and keep you informed of progress
4. We will credit you in the fix announcement (unless you prefer to remain anonymous)

## Supported Versions

Security updates are provided for the latest release. We recommend always running the most recent version.

## Security Practices

Fabric AI implements the following security measures:

- **Data isolation**: Multi-tenant architecture with PostgreSQL Row-Level Security (RLS)
- **Encryption**: API keys encrypted at rest; all traffic encrypted in transit (TLS)
- **Authentication**: Session-based auth via Better Auth with support for 2FA, passkeys, and OAuth
- **Authorization**: Procedure-level access control with tenant validation
- **Input validation**: Zod schema validation on all API inputs
- **SQL injection prevention**: Prisma ORM with parameterized queries
- **XSS risk reduction**: React's default output escaping and explicit sanitization of untrusted HTML before rendering
- **Rate limiting**: Token bucket algorithm for API endpoints
- **Audit logging**: Operation tracking for compliance

## Scope

The following are in scope for security reports:

- Authentication and authorization bypasses
- Data isolation failures (cross-tenant data access)
- Injection vulnerabilities (SQL, XSS, command injection)
- Sensitive data exposure
- Insecure API key handling
- Server-side request forgery (SSRF)

The following are out of scope:

- Denial of service attacks
- Social engineering
- Issues in third-party dependencies (report to the upstream project)
- Issues requiring physical access to infrastructure

## Code Scanning

The public repository runs CodeQL (`security-extended` suite) on every push to `master` and weekly, from [`.github/workflows/codeql.yml`](./.github/workflows/codeql.yml). It deliberately does not run on pull requests: PR annotations post as review threads that the conversation-resolution rule on `master` would make the relay unable to squash. Alerts land in the Security tab, where they are visible only to people with write access, and are triaged there. The Semgrep step in `security.yml`'s single `security` job remains the PR-time SAST gate for both repositories.

### Triage policy

Every alert is either fixed or dismissed in the alert itself with a reason that names the data source and the sink — never a bare "false positive". These are the standing rules. The first set was written when the initial baseline (250 alerts) from GitHub's default-setup scan was triaged; that scan ran only the default suite, so the workflow's first `security-extended` upload raised a second baseline (126 alerts, mostly in medium-precision families the default suite omits), triaged the same day under the rules added for those families:

- **`js/request-forgery`** — fixed wherever the *host* of an outbound request can be influenced by a caller. A caller-influenced path segment on a host that is a literal, comes from a stored, validated integration configuration, or is validated at request time against an allow-list derived from the provider's own account metadata is dismissed as a false positive, naming the fixed host or the allow-list and where it comes from. A path-only pattern that decides whether to attach a credential (attachment fetchers) is fixed by pinning scheme and hostname, because the same predicate also gates where the secret is sent.
- **`js/polynomial-redos`, `js/redos`** — fixed when the regex runs over unbounded input a caller can author directly: request bodies and parameters, user documents or chat text, uploads, third-party integration payloads, fetched web content. Dismissed as *won't fix* when the input is developer-authored (prompt templates, config, model identifiers, repository paths), length-bounded before matching — the dismissal names the schema or slice and establishes that it bounds *every* path into the regex, since a bound on one caller of an exported helper is not enough — or model output, which is bounded by the model's maximum output tokens and cannot be shaped precisely by a caller. Client-only code, where the cost falls on the caller's own browser tab, is also *won't fix*.
- **Sanitization rules** (`js/incomplete-*-sanitization`, `js/bad-tag-filter`, `js/double-escaping`, `js/xss-through-dom`) — real only when the result reaches an HTML or DOM sink, a host-trust decision, or a shell. A `.replace()` that formats text for a prompt, a markdown document, a log line, a slug, a hash input or a JSON field is a false positive, and the dismissal names that sink. A substring host check that gates trust is fixed by parsing the URL and comparing the hostname exactly. When a `js/double-escaping` fix is only reordering the replacement chain (decode `&amp;` last), it is fixed regardless of sink: the change is behaviour-identical for every singly-escaped input.
- **`js/insufficient-password-hash`** — SHA-256 or HMAC of a random API key or bearer token for lookup and constant-time comparison is not a password hash and is a false positive. Only a user-chosen secret needs a key-derivation function.
- **`js/insecure-randomness`** — fixed when the value must be unguessable or collision-free and nothing else checks ownership (session handles, identifiers persisted as keys). A false positive when it is jitter, a display id, a sample choice, or a handle whose every use re-checks the caller's identity.
- **`js/tainted-format-string`** — fixed: the request-derived value moves out of the `console.*` format string. The impact is log confusion only, so it never blocks a release on its own.
- **`js/log-injection`** — same shape as `js/tainted-format-string`: fixed when a request-, webhook- or integration-derived string is interpolated into a log *message* — including through a `%s`/`%d` placeholder, which `util.format` inlines. The fix passes the value as a separate object argument (`console.warn("…", { value })`), which `util.inspect` serialises with control characters escaped; a bare string as a separate positional argument is not enough. A false positive when the separate argument is a caught `Error` or its `.message`/`.stack`, or when the value is narrowed before the log by an enum type, an allow-list lookup that returns 4xx on a miss, a `switch` over literal names, an id regex, an equality branch against literals, or a tenant/user id resolved from the session; the dismissal names the narrowing. Admin-seeded catalog rows count as developer-authored. Client-only `console.*` is *won't fix*. Log confusion only; never blocks a release.
- **`js/insecure-temporary-file`** — fixed with `fs.mkdtemp` and paths built under it; a predictable name under `os.tmpdir()` in anything that runs on shared infrastructure (web, worker, agents) is always fixed, and so is a developer script writing a fixed `/tmp` name. A false positive when the name already carries a per-attempt cryptographically random suffix at least as wide as `mkdtemp`'s and the directory is created by an operation that refuses a pre-existing non-empty path (a `git clone`); the dismissal names both.
- **`js/file-system-race`** — fixed by dropping the `exists` check and handling the operation's error (`ENOENT`, or `{ flag: "wx" }` to create-if-absent). A false positive when the checked path is inside a directory this process created with a random suffix and only this process writes there, or a repo-relative, gitignored cache written by one build-time process; a stat-then-read that enforces a size bound stays, since the worst case is reading a file over the bound.
- **`js/http-to-file-access`** — real when fetched bytes land at a path or content type an attacker can influence and something later executes or loads them. A false positive for a developer-run tool caching assets fetched over TLS from a literal host under its own gitignored directory at a hash-of-URL name, consumed only by that tool; and for CI appending a type-checked API response about a resource it created itself to `$GITHUB_STEP_SUMMARY`, which is rendered as markdown and never executed.
- **`js/user-controlled-bypass`** — fixed when a caller-controlled field (body, query or header) selects the *permissive* side of an authorisation or verification branch: a request that supplies the value reaches privileged work that one without it would not. A false positive when the value can only take the *restrictive* side — a required-field or allow-list guard whose only other outcome is an early 4xx that ends the request — when it selects between two equally-authorised paths, or when the deciding value was already authenticated or derived server-side, which the dismissal names. The query flags any input guard that lexically precedes a call whose name matches its sensitive-action heuristic (`verify*`, `isAuthorized*`, `hasProjectAccess`), so validating cheap required fields before the auth call is the correct shape and stays a false positive.
- **`js/regex/missing-regexp-anchor`** — fixed whenever the match selects which stored credential, integration, outbound target or sandbox a value is handed to, even when today's failure mode is only a failed lookup. For a host decision the fix is to parse the URL (rewriting scp-style `git@host:path` first) and compare `hostname` exactly or as a `.domain` suffix — anchoring a URL regex silently drops the scp-style and scheme-less forms these callers accept, so anchoring is for non-URL identifiers only. A false positive when the match selects only text a human reads (help copy, error strings) or only *refuses* something with a message, so a lookalike host is blocked rather than trusted. When an expression is fixed, its identical siblings in the same file are fixed in the same change rather than dismissed.
- **`js/remote-property-injection`** — fixed by allow-listing the key set, by `Object.fromEntries` when the keys are legitimately open-ended and callers need a plain record (it defines own data properties and never invokes the `__proto__` setter), or by a `Map`/`Object.create(null)`. A false positive when the key set is a validated enum before use.
- **`js/missing-origin-check`** — fixed by checking `event.origin` on the *inbound* `message` handler against the expected origin(s). For a route that is deliberately framable cross-origin, only the inbound RPC is pinned; proactive `ready` / `set-height` notices stay broadcast, since pinning their `targetOrigin` silently breaks third-party auto-sizing. A false positive only when the handler treats the data as opaque display text with no state change.
- **`actions/untrusted-checkout`** — fixed unless the workflow never runs untrusted code from the checked-out ref. The dismissal lists the triggers and states that no `pull_request` / `pull_request_target` trigger exists, which is the single fact that settles it.
- Test files are dismissed as *used in tests*.

The alert's `dismissed_comment` field is capped at 280 characters by GitHub, so a dismissal is one dense sentence naming source and sink followed by `Policy: SECURITY.md § Code Scanning, <rule>.`; longer reasoning belongs in the fixing PR, not the alert.

A dismissal describes the code as it is. When a dismissed sink later gains an untrusted input, the alert is reopened and fixed rather than left under the old reason.

## Dependency Vulnerability Management

This section governs how we respond to Dependabot / osv-scanner alerts on our own dependency graph.

### Service-level targets

Severity is taken from the advisory (GHSA / CVE). "Production" means the vulnerable package is reachable from a runtime entry point — anything imported into `apps/web`, `agents/**`, `packages/api`, `packages/temporal`, etc. "Dev-only" means it is reachable only from build tooling, tests, linters, or codegen.

| Class                      | Target resolution time |
| -------------------------- | ---------------------- |
| Production CRITICAL / HIGH | 7 days                 |
| Production MEDIUM          | 30 days (monthly batch)|
| Production LOW             | 90 days (quarterly)    |
| Dev-only, any severity     | 30 days (monthly batch)|

Run `osv-scanner scan source --lockfile=pnpm-lock.yaml` to list advisories against the lockfile.

> `pnpm audit` is no longer usable here: npm retired the legacy quick-audit endpoint it posts to, and it now returns HTTP 410 for every request. `pnpm audit` therefore reports nothing regardless of the lockfile's contents.

### Resolution order of preference

1. **Bump the direct dependency.** If we depend on the parent package directly, upgrade it. Do not override a transitive when we control the parent.
2. **`pnpm.overrides` for transitives we don't control.** Use scoped overrides (e.g. `"undici@^6.0.0": "^6.24.0"`) so the override doesn't leak across majors. Every entry should resolve a tracked alert.

   Scoped is not just about majors — a **bare** override key can silently fail to bite. `"vite": "^7.3.5"` was added in #1803 and never took: pnpm rewrote vitest's peer range to match but left the resolution at the vulnerable `vite@7.3.2`, so `pnpm-lock.yaml` still carried it for six weeks. The scoped `"vite@^7.0.0"` form resolves correctly. **After adding any override, confirm the lockfile actually moved** (`grep '<pkg>@' pnpm-lock.yaml`) — do not assume the declaration is the fix.
3. **Dismiss with reason** for alerts we will not patch (dev-only, false positive, no fix available, or major-version risk on a transitive of a pinned parent). Dismiss in the Dependabot UI **and** add the advisory to [`osv-scanner.toml`](./osv-scanner.toml) with an `ignoreUntil` date, plus a row in the table below. `ignoreUntil` makes the advisory fail CI again once it lapses, so a dismissal cannot outlive its re-evaluation.

### CI enforcement

High and critical advisories must stay clean on `master`. The gate is the pair of dependency-audit steps in the `security` job of [`.github/workflows/security.yml`](./.github/workflows/security.yml): osv-scanner reads the lockfiles against osv.dev, and [`tooling/scripts/src/osv-severity-gate.mjs`](./tooling/scripts/src/osv-severity-gate.mjs) fails the build on any undismissed high or critical. Medium-or-below findings are reported in the job summary and tracked in Dependabot, but do not block.

**What the gate actually covers.** Lockfiles are named explicitly in the workflow, so coverage is whatever that list says:

| Lockfile | Ecosystem | Packages |
|---|---|---|
| `pnpm-lock.yaml` | npm | 3458 |
| `packages/fabric-agent-python/uv.lock` | PyPI | 52 |
| `aspire/Fabric.AppHost/packages.lock.json` | NuGet | 117 |
| `aspire/Fabric.ServiceDefaults/packages.lock.json` | NuGet | 22 |

Add new lockfiles to that list or they are not scanned. The two non-npm ecosystems only became scannable on 2026-07-21: the Python package had no committed lockfile at all, and the .NET projects needed `RestorePackagesWithLockFile` before they emitted one. Keep both properties in place — dropping them silently removes 191 packages from the audit.

Docker base-image OS packages stay outside this gate: they are not a source manifest, and the Trivy image scan covers them separately (`vuln-type: os`).

When reading a run, take coverage from the job's stderr lines (`Scanned <file> ... found N packages`), **not** from the JSON `results` array — that array only contains sources that produced findings, so a clean lockfile looks identical there to one that was never scanned.

The gate covers the full graph rather than `--prod` only, because dev-graph tooling still executes in CI and on developer machines. Where a dev-only advisory is genuinely unreachable from the shipped runtime, it is dismissed explicitly in the table below rather than filtered out wholesale.

### Override hygiene

`pnpm.overrides` is tactical, not permanent. Each override entry should be removable once the upstream parent releases a version that ships the patched transitive. Audit overrides at every quarterly dependency-bump cycle and drop entries that are no longer needed.

### Documented dismissals

Advisories listed in [`osv-scanner.toml`](./osv-scanner.toml) are dismissed with a written reason here. Each carries an `ignoreUntil` date and is re-evaluated quarterly.

| GHSA | Package / chain | Reason | Ignore until |
| ---- | --------------- | ------ | ------------ |
| `GHSA-jmr9-qjv8-65gv` | `extract-zip@2.0.1` via `@langchain/langgraph-cli` → (`create-langgraph`) | Symlink path traversal during zip extraction (CWE-22). **No upstream fix exists**: `2.0.1` is both the advisory's `last_affected` version and the newest ever published, and the current `@langchain/langgraph-cli` (1.4.5, re-checked 2026-09-02) still declares `extract-zip: ^2.0.1`, so neither the package nor its parent can be upgraded out of it. **Not reachable from deployed code**: the only `import ... from "extract-zip"` in the installed CLI is `dist/cli/dev.python.mjs`, which uses it to unpack the `uv` Python package-manager binary — the Python project path of `langgraph dev`, on Windows only (other platforms take the `.tar.gz`/`tar` branch). Every agent this repo deploys is TypeScript and every agent image runs `node dist/<server>.js`; the one runtime `npx @langchain/langgraph-cli dev` spawn lives in `proxy-server.ts`, which is not a `tsup` entry in any agent and so is never built into an image. Exploitation would additionally require the upstream `uv` release asset to be replaced with a malicious archive, which already implies arbitrary code execution via the binary the CLI then `chmod 0755`-es and runs. Re-check npm for a `2.0.2`+ or a `langgraph-cli` that drops the dependency before the expiry. | 2026-11-12 |


Removed dismissals, kept for the audit trail:

| GHSA | Package / chain | Outcome |
| ---- | --------------- | ------- |
| `GHSA-8988-4f7v-96qf` | `@opentelemetry/core@1.30.1` via `@temporalio/interceptors-opentelemetry@1.16.3` | Dismissed 2026-08 as unreachable — the vulnerable `W3CBaggagePropagator` was only constructible from a lazy `getTracer()` that Temporal's OTel *workflow* interceptors call and this repo never registered — because the `1.x` line ended at `1.30.1`, `2.8.0` was the first fixed release, and no Temporal release then published escaped OpenTelemetry v1 (`1.22.0` still declared `@opentelemetry/core: ^1.25.1`). Removed 2026-09-04 by the upgrade the entry was waiting for: `@temporalio/*` moved to `~1.23.0` and the v1 interceptors package was replaced by `@temporalio/interceptors-opentelemetry-v2`, which declares `@opentelemetry/core: ^2.2.0`. That was the only top-level introducer of the v1 island, and the island is now gone from the lockfile outright — no `@opentelemetry/core`, `@opentelemetry/resources` or `@opentelemetry/sdk-trace-base` resolves to a `1.x` version — so the ignore covers nothing. |
| `GHSA-ggr8-5vv4-36mx` | `deepmerge-ts@7.1.5` via `@prisma/config` ← `prisma@6.18.0` | Dismissed 2026-08 as an availability-only stack exhaustion on a build-time path fed by our own config, declining the available patch because `@prisma/config` pins `deepmerge-ts` at exactly `7.1.5` and the fix landed in a new major (`8.0.0`). Removed 2026-09-02 by taking that patch: the root `pnpm.overrides` entry `deepmerge-ts` → `^8.0.2` replaces the exact pin, the way `undici@^5.0.0` → `^6.27.0` already does, and the lockfile now resolves `8.0.2`. Safe for this consumer because `@prisma/config` imports only `{ deepmerge }` and hands it to c12 as `merger` (`dist/index.js:894,917`); none of the `8.0.0` breaking changes (`deepmergeInto` aliasing, the `mergeInfo` rename, deep `Map` merging) touch that call. Verified 2026-09-02: c12 `loadConfig` with the `deepmerge` export of `deepmerge-ts@8.0.2` as `merger` merges a `prisma.config` layer over defaults correctly, and merging a self-referential object returns instead of exhausting the stack. `8.0.2` has zero dependencies and requires `node >=16.9.0`. Re-check whether `@prisma/config` has adopted `8.x` itself (still `7.1.5` through `7.10.0`) so the override can be retired. |
| `GHSA-mh99-v99m-4gvg` | `brace-expansion@1.1.16` and `@2.1.2` via `minimatch@3` / `minimatch@5–9` (glob and tooling graph) | Dismissed 2026-07-24 while the 1.x/2.x maintenance lines had no backported fix (5.x was fixed via the `brace-expansion@^5.0.0` override → `5.0.8`). Removed 2026-08-03: the backports the entry was waiting for exist and are installed — the lockfile now resolves `1.1.18` and `2.1.4`, both past the advisory's fixed versions, so the ignore no longer covers anything. |
| `GHSA-vrm6-8vpv-qv8q` | `undici@5.x` via `party → partykit → miniflare` | Dismissed 2026 as local-dev only (production collab runtime is `party-cf/` on Cloudflare Workers, no `undici` in its graph). Removed 2026-07-24: `undici@5` left the lockfile entirely and osv-scanner flagged the ignore as unused. |
| `GHSA-v9p9-hfj2-hcw8` | `undici@5.x` via `party → partykit → miniflare` | Same chain and outcome as above. |
| `GHSA-vxpw-j846-p89q` | `undici` (WebSocket continuation-frame DoS) | Same chain as above; first-party `undici` resolves to `8.7.0`, which ships the fix (patched upstream in `undici@8.5.0`). Removed 2026-07-24 as an unused ignore. |
