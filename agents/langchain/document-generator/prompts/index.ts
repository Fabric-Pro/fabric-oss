/**
 * Document Generator Prompts Module
 *
 * Handles system prompt generation for document generation.
 * Uses unified prompt builder for consistency.
 */

import { buildUnifiedSystemPrompt } from "@repo/agent-prompts";
import type { DocumentType, ProjectContext } from "@repo/agent-types";

/**
 * Build the system prompt for document generation
 *
 * Uses unified prompt builder for consistency with project-document-generator.
 * Supports optional project context and RAG contexts when available.
 */
function buildSystemPromptSync(
	customPrompt: string | undefined,
	documentType: DocumentType,
	existingDocument: string | undefined,
	projectContext?: ProjectContext,
	ragContexts?: string[],
): string {
	console.log("[Document Generator] Building prompt with unified builder", {
		hasCustomPrompt: !!customPrompt,
		hasExistingDocument:
			!!existingDocument && existingDocument.trim().length > 0,
		hasProjectContext: !!projectContext,
		hasRagContexts: !!ragContexts && ragContexts.length > 0,
		documentType,
	});

	// Use unified builder - supports optional project context and RAG contexts
	// Note: hasCopilotKitActions is FALSE because the standalone document-generator
	// only binds write_document_local, NOT regenerate_document.
	// Setting this to true would tell the model about a tool that doesn't exist.
	return buildUnifiedSystemPrompt({
		customPrompt,
		documentType,
		projectContext, // Optional - will be included if provided
		ragContexts: ragContexts || [], // Optional - will be included if provided
		existingDocument,
		useFabricAI: false, // Standalone generator doesn't use Fabric AI by default
		qualityTier: "standard",
		hasCopilotKitActions: false, // Only write_document_local is bound - no regenerate_document
	});
}

/**
 * Build the system prompt for document generation
 *
 * @param customPrompt - Optional custom system prompt from Prompt Library
 * @param documentType - Type of document being generated
 * @param existingDocument - Optional existing document content
 * @param projectContext - Optional project context (if available)
 * @param ragContexts - Optional RAG contexts (if available)
 * @returns The system prompt to use
 */
export function buildSystemPrompt(
	customPrompt: string | undefined,
	documentType: DocumentType,
	existingDocument: string | undefined,
	projectContext?: ProjectContext,
	ragContexts?: string[],
): string {
	return buildSystemPromptSync(
		customPrompt,
		documentType,
		existingDocument,
		projectContext,
		ragContexts,
	);
}

/**
 * Get the predict_state metadata configuration for AG-UI protocol
 *
 * This enables predictive state updates for real-time streaming.
 *
 * @returns Predict state configuration
 */
export function getPredictStateConfig() {
	return [
		{
			state_key: "document",
			tool: "write_document_local",
			tool_argument: "document",
		},
		{
			state_key: "focusAnchor",
			tool: "write_document_local",
			tool_argument: "focusAnchor",
		},
	];
}
