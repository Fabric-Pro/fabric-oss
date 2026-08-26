/**
 * Core prompt modules
 */

export {
	getBaseInstructions,
	QUALITY_TIER_INSTRUCTIONS,
	WRITING_GUIDELINES,
} from "./base-instructions";
export {
	type ApplyPatchesResult,
	applyPatches,
	type DocumentPatch,
	detectRenameIntent,
	diagnoseOverlap,
	findAllMarkdownStructureDefects,
	formatLineRange,
	listAnchorPaths,
	type MarkdownStructureDefect,
	type OverlapIntent,
	type PatchError,
	type PatchErrorCode,
	type PatchOp,
	type RenameIntent,
	type ReplaceTextStat,
	type ResolvedAnchor,
	resolveAnchor,
	type ValidatePatchesResult,
	validateMarkdownStructure,
	validatePatches,
} from "./document-patches";
export {
	buildFollowUpInstructions,
	type FollowUpQuestion,
	type FollowUpQuestionOptions,
	generateFollowUpQuestions,
} from "./follow-up-questions";
export {
	getMarkdownFormattingRulesPrompt,
	MARKDOWN_FORMATTING_RULES,
} from "./formatting-rules";
export type { FunctionTagClauseInput } from "./function-tag-context";
export { getFunctionTagContextClause } from "./function-tag-context";
export { getInBodyAttachmentPreservationClause } from "./in-body-attachment-preservation";
export { getLockedAttachmentRulesClause } from "./locked-attachment-rules";
export { repairDegradedMarkdown } from "./markdown-repair";
export {
	getPendingDecisionsIntegrationClause,
	PENDING_DECISIONS_HEADING,
} from "./pending-decisions-integration";
export {
	type ContextWithMetadata,
	formatRagContexts,
	formatRagContextsWithMetadata,
	RAG_USAGE_INSTRUCTIONS,
	STRONG_RAG_INSTRUCTIONS,
} from "./rag-instructions";
export {
	buildToolInstructions,
	getSummaryInstructions,
} from "./tool-instructions";
