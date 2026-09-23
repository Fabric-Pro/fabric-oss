---
"fabric-app": patch
---

The pull-request "Review for test coverage" button now runs under the project's organization, using its AI provider and spend ledger instead of reporting that none is configured.

Fizzy #2253. The manual QA-lens path passed `organizationId: null` into the lens, which resolved the
operator's personal context; an organization with a provider configured was refused, and any
spend would have landed on a personal ledger that no organization cap governs. The webhook path
passed the project's organization, so the two paths disagreed.

`runQaLens` now resolves the tenant itself from the project row (`getProjectTenantId`, the helper
semantic search already uses for the same reason) and no longer accepts an `organizationId`
parameter, so neither caller can supply the wrong one. The no-provider message now names the
project's organization and points at Settings ▸ AI Providers (the old "AI Assistant" settings
page does not exist).
