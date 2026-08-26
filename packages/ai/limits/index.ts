/**
 * Re-export of the canonical limit classifier, which lives in `@repo/utils`.
 *
 * It moved there because the LangChain agents need it too and cannot import
 * `@repo/ai` — that package pulls in `@repo/database` for dynamic model
 * selection, so the agent bundles mark it `external` (see each agent's
 * `tsup.config.ts`). `@repo/utils` is a leaf package both sides already
 * depend on, so one implementation now serves the API/Temporal paths and the
 * agent paths alike. Existing importers of `@repo/ai/limits` are unaffected.
 */
export {
	classifyLimitError,
	sanitizeProviderMessage,
} from "@repo/utils/classify-limit-error";
export type {
	LimitKind,
	LimitSignal,
	TokenBudgetStatus,
} from "@repo/utils/limit-signal";
