/**
 * Artifacts Module
 *
 * Typed artifact system for structured data flow between steps.
 * Part of Phase 4: Rich Context Flow.
 */

// Store and factory functions
export {
	artifactToString,
	createApiResponseArtifact,
	createBrowserStateArtifact,
	createCodeArtifact,
	createDataArtifact,
	createDocumentArtifact,
	createErrorArtifact,
	createFileArtifact,
	createSummaryArtifact,
	createToolResultArtifact,
	// Transformers
	extractDataFromToolResult,
	getArtifactsContext,
	InMemoryArtifactStore,
	summarizeArtifacts,
} from "./artifact-store";
// Types
export {
	type ApiResponseArtifact,
	type Artifact,
	type ArtifactStore,
	type ArtifactType,
	type BaseArtifact,
	type BrowserAction,
	type BrowserStateArtifact,
	type CodeArtifact,
	type DataArtifact,
	type DocumentArtifact,
	type DocumentSection,
	type ErrorArtifact,
	type FileArtifact,
	isApiResponseArtifact,
	isBrowserStateArtifact,
	// Type guards
	isCodeArtifact,
	isDataArtifact,
	isDocumentArtifact,
	isErrorArtifact,
	isFileArtifact,
	isPlanArtifact,
	isSummaryArtifact,
	isToolResultArtifact,
	type PlanArtifact,
	type StepInput,
	type StepIOContract,
	type StepOutput,
	type SummaryArtifact,
	type ToolResultArtifact,
} from "./types";
