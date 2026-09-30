---
"fabric-app": patch
---

Saving, changing or deleting an AI provider configuration is now recorded in the audit log, without the API key or client secret.

Fizzy #2174 follow-up. Every mutation in the AI provider settings now emits an audit event: `org.ai_provider.*` and `account.ai_provider.*` for configured, updated, default_changed, embedding_changed, enabled_providers_changed and deleted. Each row names the provider and the config id, and records non-secret before/after state (endpoint host and path, deployment name, whether a service-principal client id is set, default, enabled and embedding flags) plus whether a new key was supplied. The key, client secret and their encrypted forms are never recorded, and a base URL is reduced to host and path so pasted userinfo or query strings do not reach the trail. Overwriting a config used to leave no trace, so a replaced credential could not be traced or recovered.
