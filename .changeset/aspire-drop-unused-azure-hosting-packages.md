---
"fabric-app": patch
---
Drop the five unused Aspire.Hosting.Azure packages from the AppHost so the security-scanned .NET lock file no longer carries the Azure SDK graph.

The AppHost referenced Aspire.Hosting.Azure, .Azure.AppContainers, .Azure.Redis, .Azure.PostgreSQL and .Azure.KeyVault, but no code under aspire/ calls any AddAzure*/AsAzure*/PublishAsAzure* API; publish mode only builds plain container resources from a registry image URL. Those references pulled Azure.Identity, Azure.Core, Azure.Provisioning.* and Azure.ResourceManager.* into packages.lock.json, which is an osv-scanner input gated by the severity gate, so an advisory in code that never executes could redden the security check. Removing them shrinks the lock file from 118 to 87 entries. The lock file was regenerated with the committed win-x64 RID entries kept. (Fizzy #2372)
