---
"fabric-app": patch
---

Azure AI Foundry can now be connected in AI Providers settings, including project /openai/v1 endpoints, and Test Connection checks your deployment.

Fizzy #2174. Test Connection accepts the `.cognitiveservices.azure.com` and `.services.ai.azure.com` hosts and the project endpoint `https://{resource}.services.ai.azure.com/api/projects/{project}/openai/v1`. It sends the deployment name you enter and no longer asks Azure for a deployment list it does not answer. The org and personal AI Providers forms send one deployment-name value to both Test Connection and Save, and testing a saved provider uses its stored deployment name.

A project /openai/v1 endpoint routes by the `model` field in the request body and rejects `api-version`; a resource endpoint routes by `/openai/deployments/{name}` and needs `api-version`. `resolveAzureDeploymentTarget` in `@repo/ai/lib/azure-foundry-url` picks the shape once, and both the model factory (chat and embeddings) and the tester use it, so a passing test means the app's own calls reach the deployment.

The probe asks for at most one output token. A 400 passes only when Azure's error shows the deployment ran: the token cap was hit (reasoning models) or an older gpt-35-turbo or gpt-4 deployment rejected `max_completion_tokens`. Any other 400 fails and shows Azure's message, and `OperationNotSupported` still means the deployment cannot serve chat.
