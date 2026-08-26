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

High and critical advisories must stay clean on `master`. The gate is the `Dependency audit (high+)` job in [`.github/workflows/security.yml`](./.github/workflows/security.yml): osv-scanner reads the lockfiles against osv.dev, and [`tooling/scripts/src/osv-severity-gate.mjs`](./tooling/scripts/src/osv-severity-gate.mjs) fails the build on any undismissed high or critical. Medium-or-below findings are reported in the job summary and tracked in Dependabot, but do not block.

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
| `GHSA-jmr9-qjv8-65gv` | `extract-zip@2.0.1` via `@langchain/langgraph-cli` → (`create-langgraph`) | Symlink path traversal during zip extraction (CWE-22). **No upstream fix exists**: `2.0.1` is both the advisory's `last_affected` version and the newest ever published, and the current `@langchain/langgraph-cli` (1.4.4) still declares `extract-zip: ^2.0.1`, so neither the package nor its parent can be upgraded out of it. **Not reachable from deployed code**: the only `import ... from "extract-zip"` in the installed CLI is `dist/cli/dev.python.mjs`, which uses it to unpack the `uv` Python package-manager binary — the Python project path of `langgraph dev`, on Windows only (other platforms take the `.tar.gz`/`tar` branch). Every agent this repo deploys is TypeScript and every agent image runs `node dist/<server>.js`; the one runtime `npx @langchain/langgraph-cli dev` spawn lives in `proxy-server.ts`, which is not a `tsup` entry in any agent and so is never built into an image. Exploitation would additionally require the upstream `uv` release asset to be replaced with a malicious archive, which already implies arbitrary code execution via the binary the CLI then `chmod 0755`-es and runs. Re-check npm for a `2.0.2`+ or a `langgraph-cli` that drops the dependency before the expiry. | 2026-11-12 |

| `GHSA-ggr8-5vv4-36mx` | `deepmerge-ts@7.1.5` via `@prisma/config` ← `prisma@6.18.0` | Stack exhaustion when merging recursive object graphs (availability only; `CVSS:4.0/…/VC:N/VI:N/VA:H`). **Patching is possible but declined.** `8.0.0` is the first fixed release, and although `@prisma/config` depends on `deepmerge-ts` at the exact version `"7.1.5"` rather than a range, a `pnpm.overrides` entry replaces a declared spec outright — this repo already forces majors that way (`undici@^5.0.0` → `^6.27.0`). Verified: `"deepmerge-ts": "^8.0.1"` resolves the edge to `8.0.1`, and the override's own lockfile delta is the override echo, one `resolution:` block, one snapshot key and that single edge (a lockfile refresh also picks up unrelated registry metadata churn — deprecation strings and peer hashes — which the override does not cause). `8.0.1` has zero dependencies and the same `engines: node >=16.0.0` as `7.1.5`, and none of the `8.0.0` breaking changes reach this consumer: `@prisma/config` imports only `{ deepmerge }` and hands it to c12 as `merger` (`dist/index.js:894,917`), never calling `deepmergeInto` or merging `Map` values. We decline it because that forces an unsupported major into a third-party CLI's own config loader, which is a worse trade than an availability-only flaw on a path no untrusted input reaches: `deepmerge-ts` enters the lockfile through this one chain and no other, `prisma` is an optional peer of `@prisma/client` (which declares no dependencies at all), and `@prisma/config` runs only while the CLI loads config — `generate`, `migrate`, `db push` — never at request time. What it merges is our own configuration, and this repo ships no `prisma.config.*` file, so the loader sees defaults and CLI flags. The realistic worst case is a build step running out of stack. **Expect to renew rather than remove**: every `@prisma/config` release through the current latest (`7.9.1`) still pins `deepmerge-ts` at exactly `7.1.5`, so "has Prisma moved to 8?" will most likely still be false at the expiry. If renewing a second time, take the override instead. | 2026-11-17 |

| `GHSA-8988-4f7v-96qf` | `@opentelemetry/core@1.30.1` via `@temporalio/interceptors-opentelemetry@1.16.3` | Unbounded memory allocation parsing inbound `baggage` headers — `W3CBaggagePropagator.extract()` enforced no size cap where `inject()` already did (availability only; `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L`, 5.3). **Only the v1 copy is affected.** The lockfile carries two: the v2 copy is already patched by the existing `@opentelemetry/core@^2.0.0` → `^2.8.0` override, which resolves it to `2.10.0`. **No fix exists for the v1 line and an override is not viable.** The 1.x line ended at `1.30.1`; `2.8.0` is the first fixed release. Three packages depend on the v1 copy directly — `@temporalio/interceptors-opentelemetry`, `@opentelemetry/resources@1.30.1` and `@opentelemetry/sdk-trace-base@1.30.1` — but the Temporal package is the only top-level introducer of that island, and its current latest (`1.22.0`) still declares `@opentelemetry/core: ^1.25.1`, so upgrading Temporal does not escape v1; `@repo/temporal` also pins the SDK at `~1.16.3`. Forcing v2 in breaks the island at **require time**: v2 removed 20 of v1's 64 exports, and `sdk-trace-base@1.30.1`'s `config.js` dereferences the removed `TracesSamplerValues` at module top level (`const FALLBACK_OTEL_TRACES_SAMPLER = core_1.TracesSamplerValues.AlwaysOn`), with five further `getEnv()` calls and one `getEnvWithoutDefaults()` behind it. **The vulnerable propagator is never constructed from this copy.** The interceptors package imports one symbol from v1 core — the `ExportResultCode` enum, in `lib/workflow/span-exporter.js`. Its `lib/workflow/index.js` *is* loaded eagerly (the package root re-exports it, and `packages/temporal/src/telemetry.ts` imports from that root), but the `new BasicTracerProvider()` + `provider.register()` pair that would build a v1 `W3CBaggagePropagator` sits inside a lazy `getTracer()`, called only by Temporal's OpenTelemetry *workflow* interceptors. This repo never registers those: `getCombinedInterceptors()` in `packages/temporal/src/worker.ts` sets `workflowModules` to its own correlation interceptor only, and workers run a prebuilt bundle from `bundleWorkflowCode({ workflowsPath })` — no `workflowInterceptorModules` — so no OTel workflow interceptor exists in the bundle to call it. No repo source calls `setGlobalPropagator` or constructs a tracer provider outside `NodeSDK`, and every installed `NodeSDK` graph resolves the patched `2.10.0`; no v1 construction path was found. Re-check whether `@temporalio/interceptors-opentelemetry` has adopted OpenTelemetry v2 before the expiry. | 2026-11-19 |

Removed dismissals, kept for the audit trail:

| GHSA | Package / chain | Outcome |
| ---- | --------------- | ------- |
| `GHSA-mh99-v99m-4gvg` | `brace-expansion@1.1.16` and `@2.1.2` via `minimatch@3` / `minimatch@5–9` (glob and tooling graph) | Dismissed 2026-07-24 while the 1.x/2.x maintenance lines had no backported fix (5.x was fixed via the `brace-expansion@^5.0.0` override → `5.0.8`). Removed 2026-08-03: the backports the entry was waiting for exist and are installed — the lockfile now resolves `1.1.18` and `2.1.4`, both past the advisory's fixed versions, so the ignore no longer covers anything. |
| `GHSA-vrm6-8vpv-qv8q` | `undici@5.x` via `party → partykit → miniflare` | Dismissed 2026 as local-dev only (production collab runtime is `party-cf/` on Cloudflare Workers, no `undici` in its graph). Removed 2026-07-24: `undici@5` left the lockfile entirely and osv-scanner flagged the ignore as unused. |
| `GHSA-v9p9-hfj2-hcw8` | `undici@5.x` via `party → partykit → miniflare` | Same chain and outcome as above. |
| `GHSA-vxpw-j846-p89q` | `undici` (WebSocket continuation-frame DoS) | Same chain as above; first-party `undici` resolves to `8.7.0`, which ships the fix (patched upstream in `undici@8.5.0`). Removed 2026-07-24 as an unused ignore. |
