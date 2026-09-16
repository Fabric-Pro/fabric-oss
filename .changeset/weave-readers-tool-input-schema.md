---
"fabric-app": patch
---

The weave reader agents (Thread, Spindle, Weft, Warp) now advertise their web-search, web-fetch and sandbox tools to the model with real input schemas, so the model can pass a search query, a URL or a file path instead of being limited to argument-less calls.

Fizzy #2525. All ten AI SDK tools in `agents/langchain/weave-readers/src/tools/` were built with the pre-v5 `parameters` key. The AI SDK renamed it to `inputSchema` in v5, and on the `ai` 6 line the unknown key was ignored: `asSchema()` substituted an empty object schema, so `webSearch`, `fetchUrl`, `readFile` and the rest reached the model with no properties and every `execute` saw `query` / `url` / `path` as `undefined`. The type error that would have caught this was hidden by a `const tool = aiTool as any` cast at the top of each of the three tool files.

The three files now pass `inputSchema` and import `tool` from `ai` directly; with the cast gone the type checker guards the option name from here on. The package's `zod` range moves from `^3.22.4` to `^3.25.76`, the floor `ai` 6 requires for schema conversion — the lockfile already resolved 3.25.76, so only the declared range changes.

A new `src/tools/tool-schemas.test.ts` drives each factory through `generateText` with a mock model and asserts the JSON Schema the model is sent carries the zod fields (`webSearch.query` required, `fetchRfc.section` optional, the four sandbox tools non-empty, `clearRfcCache` correctly empty).
