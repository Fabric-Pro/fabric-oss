---
"fabric-app": patch
---

Log request-derived values as structured arguments and create evidence/audit temp directories with mkdtemp (CodeQL log-injection, insecure-temporary-file)

Triage of the first `security-extended` CodeQL upload on the public mirror, for four rule families: log-injection (55), insecure-temporary-file (9), file-system-race (3), http-to-file-access (3).

Fixed (32 alerts):
- log-injection (23 in apps/web, 9 in packages): request-body, webhook and MCP tool-call strings (`reason`, `isModification`, `organizationId`, `toolName`, `configId`, `resourceUri`, `channelKey`, `query`, repository `path`, `namespacedToolName`) no longer appear inside a console message string or a `%s` placeholder; they travel as an object argument so a value carrying `\r\n` cannot forge a log line.
- insecure-temporary-file (8): the Evidence project generator (temporal worker) now creates its staging directory with `fs.mkdtemp` instead of a predictable `os.tmpdir()/fabric-evidence-<name>-<timestamp>` name that `mkdir -p` would happily reuse; `scripts/audit-procedure-permissions.ts --csv` writes into a fresh `mkdtempSync` directory instead of the fixed `/tmp/procedure-audit.csv`.

Dismissed with a source/sink reason on each alert (38): enum- or allow-list-narrowed values, tenant-resolved ids, Error objects passed as separate arguments, the atlas per-attempt clone directory (48-bit random suffix, created by `git clone`), the docs-screenshot font cache, and the restore-point step summary.

Tests updated for the new call shape: `stream/cancel/__tests__/route.test.ts`, `__tests__/api/mcp-gateway-organization.test.ts`.
