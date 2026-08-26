/**
 * @repo/agent-prompts
 *
 * Centralized prompt generation for agents.
 *
 * This module provides expert-level prompts for document generation with:
 * - Expert personas for each document type
 * - Detailed section guidance
 * - Quality standards and anti-patterns
 * - RAG context integration
 * - Tool usage instructions
 */

// Builders
export {
	buildMinimalPrompt,
	buildSystemPrompt,
	buildUnifiedSystemPrompt,
	buildUnifiedSystemPromptAsync,
	type ContextAvailability,
	formatAllContext,
	formatContextAvailability,
	formatProjectContext,
	formatProjectContextCompact,
	formatRagContextsSimple,
	formatRagContextsWithMetadata as formatContextsWithMetadata,
	getQualityGuidance,
	getStructureGuidance,
	type UnifiedPromptOptions,
} from "./builders";

// Core modules
export {
	type ApplyPatchesResult,
	applyPatches,
	buildFollowUpInstructions,
	buildToolInstructions,
	type ContextWithMetadata,
	type DocumentPatch,
	detectRenameIntent,
	diagnoseOverlap,
	type FollowUpQuestion,
	type FollowUpQuestionOptions,
	type FunctionTagClauseInput,
	findAllMarkdownStructureDefects,
	formatLineRange,
	formatRagContexts,
	formatRagContextsWithMetadata,
	generateFollowUpQuestions,
	getBaseInstructions,
	getFunctionTagContextClause,
	getInBodyAttachmentPreservationClause,
	getLockedAttachmentRulesClause,
	getMarkdownFormattingRulesPrompt,
	getPendingDecisionsIntegrationClause,
	getSummaryInstructions,
	listAnchorPaths,
	MARKDOWN_FORMATTING_RULES,
	type MarkdownStructureDefect,
	type OverlapIntent,
	type PatchError,
	type PatchErrorCode,
	type PatchOp,
	PENDING_DECISIONS_HEADING,
	QUALITY_TIER_INSTRUCTIONS,
	RAG_USAGE_INSTRUCTIONS,
	type RenameIntent,
	type ReplaceTextStat,
	type ResolvedAnchor,
	repairDegradedMarkdown,
	resolveAnchor,
	STRONG_RAG_INSTRUCTIONS,
	type ValidatePatchesResult,
	validateMarkdownStructure,
	validatePatches,
	WRITING_GUIDELINES,
} from "./core";

// Document prompts
export {
	API_SPEC_PROMPT,
	ARCHITECTURE_PROMPT,
	DOCUMENT_PROMPTS,
	findSectionGroup,
	formatForbiddenPatterns,
	formatForbiddenSections,
	GENERAL_PROMPT,
	getAntiPatterns,
	getDocumentPersona,
	getDocumentPrompt,
	getDocumentSections,
	getQualityChecklist,
	getRequiredGroupsForDocType,
	listDocumentTypes,
	normalizeSectionName,
	PRD_PROMPT,
	PROPOSAL_PROMPT,
	SECTION_SEMANTIC_GROUPS,
	sectionMatchesGroup,
	TECHNICAL_SPEC_PROMPT,
	USER_STORY_FORBIDDEN_PATTERNS,
	// User story constants
	USER_STORY_FORBIDDEN_SECTIONS,
	USER_STORY_PROMPT,
	USER_STORY_REQUIREMENTS,
} from "./documents";
// Templates
export {
	formatPrdForbiddenSections,
	formatProposalForbiddenSections,
	getPrdOverrideInstructions,
	getProposalOverrideInstructions,
	getUserStoryOverrideInstructions,
	PRD_FORBIDDEN_SECTIONS,
	PRD_OPTIONAL_SECTIONS,
	PRD_REQUIRED_SECTIONS,
	PRD_TEMPLATE,
	PROPOSAL_FORBIDDEN_SECTIONS,
	PROPOSAL_TEMPLATE,
} from "./templates";
// Types
export type {
	BuildSystemPromptOptions,
	BuiltPrompt,
	DocumentPromptConfig,
	DocumentSection,
	FormattedContext,
	QualityTier,
} from "./types";
// Validation
export {
	checkFormatting,
	type DetectDroppedSectionsOptions,
	type DroppedSection,
	detectDroppedSections,
	type FormattingError,
	getSectionNames,
	hasRequiredSections,
	type ParsedHeading,
	type ParsedSection,
	parseHeadings,
	parseSections,
	type ValidationError,
	type ValidationResult,
	type ValidationWarning,
	validateDocument,
	validateHeadingHierarchy,
} from "./validation";
