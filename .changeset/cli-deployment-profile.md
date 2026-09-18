---
"fabric-app": patch
"@fabricorg/cli": patch
"@fabricorg/sdk": patch
---

The CLI now saves an explicitly selected Fabric deployment with the active profile, and coding-instructions setup syncs a published snapshot before installing its session hook. The SDK now defaults requests to `https://fabric.pro` while preserving explicit and `FABRIC_BASE_URL` overrides.
