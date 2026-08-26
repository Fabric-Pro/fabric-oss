export * from "./lib/ai-gateway-encryption";
export * from "./lib/base-url";
export * from "./lib/blank-content";
export * from "./lib/context-upload";
export * from "./lib/markdown-entities";
// `realtime-emit` is intentionally NOT re-exported from this barrel: it
// statically imports `@upstash/realtime`, `@upstash/redis`, and `zod`,
// and rolling those into the @repo/utils barrel slows cold module load
// for unrelated consumers (most prominently @repo/ai's dynamic import
// in the `getModelFunctions` test helper, which crossed Vitest's 5s
// default timeout). Consumers that need the helpers MUST import via
// the subpath: `import { ... } from "@repo/utils/realtime-emit"`.
//
// See package.json `exports["./realtime-emit"]`.
export type {
	OAuthRefreshFailure,
	OAuthRefreshRequest,
	OAuthRefreshResult,
	OAuthRefreshSuccess,
} from "./lib/oauth-refresh";
export {
	type BuildOperationResultMessageInput,
	type BuildOperationResultMessageOutput,
	buildOperationResultMessage,
	type OperationArtifact,
	type OperationOutcome,
	type OperationResultMessageMetadata,
} from "./lib/operation-result-message";
export * from "./lib/pm-tool-patterns";
export {
	normalizeQaPlaywrightScript,
	parseQaPlaywrightScript,
	type QaPlaywrightScript,
	qaPlaywrightScriptSchema,
} from "./lib/qa-script";
// NOTE: project-context is intentionally NOT re-exported from this barrel — it
// imports `node:async_hooks`, which the client bundler (Turbopack) cannot bundle
// for the browser, and this barrel is pulled into client components. Import it
// via the `@repo/utils/project-context` subpath instead (same as correlation-id).
export * from "./lib/read-only-mode";
export * from "./lib/render-newsletter-approval-chat-message";
export * from "./lib/render-newsletter-chat-message";
export * from "./lib/render-publishing-chat-message";
export * from "./lib/service-url";
export * from "./lib/upload-size-limits";
export * from "./lib/work-item-title";
export * from "./lib/work-item-type-mapping";
export * from "./lib/workspace-document-upload";
export * from "./template-renderer";
