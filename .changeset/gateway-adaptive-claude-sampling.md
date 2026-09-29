---
"fabric-app": patch
---

Requests to Claude Sonnet 5 and 5.5, Opus 4.7, 4.8, 5 and 5.5 through Vercel AI Gateway, OpenRouter or Cloudflare AI no longer send a temperature, top-p or top-k value, which those models reject.

The AI SDK Anthropic provider already dropped these parameters for direct Anthropic connections and the Databricks transport already removed temperature, but the gateway client forwards call options unchanged. `getModel` now adds a middleware on every gateway route that drops them when the model is adaptive-only Claude, keyed on the shared `isAnthropicAdaptiveOnlyModel` predicate, so planning, journey, security-scan and Fabric pattern calls with a fixed temperature cannot fail on these models.
