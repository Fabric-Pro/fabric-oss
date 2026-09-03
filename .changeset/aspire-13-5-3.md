---
"fabric-app": patch
---

Update the Aspire AppHost to 13.5.3, picking up the interaction service, dashboard refresh, and polyglot AppHost fixes.

Bumps `Aspire.AppHost.Sdk` and every `Aspire.Hosting.*` package reference from
13.4.6 to 13.5.3 (`Aspire.Hosting.Browsers` to the matching
13.5.3-preview.1.26425.3 preview, since `WithBrowserLogs` is still gated behind
ASPIREBROWSERLOGS001 in 13.5.x), and regenerates `packages.lock.json` so the
osv-scanner dependency-audit gate keeps scanning a current graph. One new
transitive package enters the lock: `Azure.ResourceManager.KeyVault`, pulled in
by `Aspire.Hosting.Azure.KeyVault` 13.5.3.

`Program.cs` needs no changes. None of the 13.5 breaking changes apply to this
AppHost: it uses no hosting-context `ServiceProvider` property, no
`PublishAsConnectionString`, and no GitHub Models integration, and the build is
clean apart from the new ASPIRE010 informational warning about
`AspireUseCliBundle` defaulting to false.

The 13.3 to 13.4 container-image regression does not repeat here: the default
Postgres tag is unchanged at 18.3 and Redis at 8.6 across 13.4.6 and 13.5.3, so
the existing `.WithImageTag("17")` pin plus the legacy `/var/lib/postgresql/data`
volume mount continue to protect the local dev database.

Docs in `aspire/README.md` were still claiming 13.3 (stale since the 13.4.6
bump) and now say 13.5.
