---
"fabric-app": patch
---

The data analyst agent now runs on Vercel AI SDK 7, so its streamed chat replies and its MCP tool calls keep working on the SDK's current major release.

Fizzy #2524. This is the pilot for the monorepo-wide SDK 7 migration and moves one package only; every other package stays on the 6.x line. The pins are the newest versions that clear the repository's release-age gate on the day this landed, not the newest published: `ai` 7.0.101, `@ai-sdk/openai` 4.0.66, `@ai-sdk/anthropic` 4.0.53, `@ai-sdk/google` 4.0.70, `@ai-sdk/mcp` 2.0.49 and `@ai-sdk/react` 4.0.104. The flip that follows will carry this package to whatever is newest-mature then.

Three chat-route changes were forced by the new major: `system` became `instructions`, because 7 rejects system-role entries inside `messages` by default; `stepCountIs` became `isStepCount` and `onFinish` became `onEnd`; and the deprecated `streamText` result helpers gave way to the stateless `createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) })`.

Selecting a saved conversation needed a fix. `@ai-sdk/react` 4 binds `setMessages` to the `Chat` instance its `id` selects, where 3 wrote through a mutable ref, so history fetched after a session change was landing in a discarded instance and the chosen conversation rendered empty. History is now applied by an effect keyed on the session it was loaded for.

`@ai-sdk/mcp` 2 changes the HTTP transport's `redirect` default from `follow` to `error`. The chat route uses that built-in transport and is affected: a redirect on its MCP URL now fails the request rather than being followed. The default is kept as it ships, because the URL is minted by Fabric's own tool-router session endpoint and points straight at the gateway, so a redirect there would signal that routing had changed rather than something to chase.
