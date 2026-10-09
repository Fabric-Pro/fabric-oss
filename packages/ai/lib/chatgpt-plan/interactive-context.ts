/**
 * The storage lives in @repo/agent-types, an ES module, so ES-module packages
 * such as agent-core can import it by name under tsx (a named import from this
 * CommonJS package fails to link there). One storage either way.
 */
export {
	aiImpersonatedUserId,
	enterAiInteractiveContext,
	isAiImpersonatedRequest,
	isAiInteractiveRequestFor,
	runWithAiInteractiveContext,
} from "@repo/agent-types/ai-interactive-context";
