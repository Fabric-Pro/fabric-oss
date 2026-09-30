---
"fabric-app": patch
---

Embeddings now work when Azure AI Foundry is configured with a project endpoint, and Test Connection names deployments that cannot serve chat.

Fizzy #2174 follow-up. Live checks against a real resource showed two defects. The project-scoped endpoint (`https://{resource}.services.ai.azure.com/api/projects/{project}/openai/v1`) answers `/embeddings` with 404, while the resource-level base (`https://{resource}.services.ai.azure.com/openai/v1`) serves both chat and embeddings. `resolveAzureDeploymentTarget` now collapses a project URL to the resource-level base for every request, so Test Connection probes the same base embeddings use.

A chat request to a non-chat deployment (embeddings, image) returns HTTP 400 with only `{"error":{"message":"The requested operation is unsupported."}}` and no `code`, so the specific "does not support chat completions" message never fired. The tester now matches that message as well as the `OperationNotSupported` code.
