/**
 * @repo/agent-prompts
 *
 * Centralized prompt generation for agents.
 * These prompts are framework and language-agnostic.
 */
import { type DocumentType, type ProjectContext } from "@repo/agent-types";
/**
 * Get system prompt for a specific document type
 * Works with agents in any language (TypeScript, Python, C#)
 */
export declare function getSystemPromptForDocumentType(
	documentType: DocumentType,
): string;
/**
 * Get system prompt for project documents
 * Includes project context and RAG-retrieved knowledge
 */
export declare function getSystemPromptForProjectDocument(
	documentType: DocumentType,
	projectContext: ProjectContext,
	ragContexts?: string[],
): string;
/**
 * Get document writing instructions
 * These instructions are appended to the system prompt
 */
export declare function getDocumentWritingInstructions(
	currentDocument?: string,
): string;
//# sourceMappingURL=index.d.ts.map
