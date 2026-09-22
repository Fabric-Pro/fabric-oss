---
"fabric-app": patch
---

Failed AI usage records now capture the provider's HTTP status code and the gateway's routing details so outages can be attributed to the gateway or the upstream model provider.

`ai_usage_log` gains two nullable columns, `errorStatusCode` and `errorDetails`, populated only on a failed row. The usage-logging middleware extracts them from the thrown error (including the Vercel AI Gateway's routing metadata) without changing retry behavior or successful-row logging, and `errorDetails` is redacted and size-capped before it is persisted.
