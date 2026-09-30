---
"fabric-app": patch
---

Azure AI Foundry accepts any of its endpoint URLs, including a copied request URL, and AI agents now use the same Azure endpoint handling as chat.

Fizzy #2174 hardening. One rule, shared through `@repo/agent-types`, reduces any pasted Azure URL to its resource origin: a path containing `/openai/v1` (any case) selects the v1 API at `<origin>/openai/v1`, anything else selects the classic `/openai/deployments/{name}` API with the shared api-version. Portal "Target URI" pastes, `/chat/completions` suffixes, project paths and query strings no longer break the connection. LangGraph agents used a private copy of the v1 check and a fixed 2024-10-21 api-version; they now use the same resolver.

Azure requests no longer follow redirects, so a 307 or 308 cannot replay the request body and `api-key` header to another host; Test Connection reports a redirect as its own failure. The base-URL field for Azure is labelled "Endpoint URL" and shows the project endpoint the portal hands out; other providers keep "Gateway URL".
