/**
 * Document Prompts Registry
 *
 * Central registry for all document type prompts.
 * Add new document types here to make them available.
 */

import type { DocumentType } from "@repo/agent-types";
import type { DocumentPromptConfig } from "../types";
import { API_SPEC_PROMPT } from "./api-spec";
import { ARCHITECTURE_PROMPT } from "./architecture";
import { BUSINESS_CASE_PROMPT } from "./business-case";
import { GENERAL_PROMPT } from "./general";
// Import all document prompts
import { PRD_PROMPT } from "./prd";
import { PROPOSAL_PROMPT } from "./proposal";
import { QA_STRATEGY_PROMPT } from "./qa-strategy";
import { SRS_PROMPT } from "./srs";
import { TECHNICAL_SPEC_PROMPT } from "./technical-spec";
import { USER_STORY_PROMPT } from "./user-story";

/**
 * Registry of all document prompts by type
 */
export const DOCUMENT_PROMPTS: Record<DocumentType, DocumentPromptConfig> = {
	prd: PRD_PROMPT,
	proposal: PROPOSAL_PROMPT,
	architecture: ARCHITECTURE_PROMPT,
	technical_spec: TECHNICAL_SPEC_PROMPT,
	api_spec: API_SPEC_PROMPT,
	user_story: USER_STORY_PROMPT,
	business_case: BUSINESS_CASE_PROMPT,
	qa_strategy: QA_STRATEGY_PROMPT,
	srs: SRS_PROMPT,
	general: GENERAL_PROMPT,
};

/**
 * Get the prompt configuration for a document type
 *
 * @param documentType - The type of document
 * @returns The prompt configuration, or general prompt as fallback
 */
export function getDocumentPrompt(
	documentType: DocumentType,
): DocumentPromptConfig {
	const prompt = DOCUMENT_PROMPTS[documentType];
	if (!prompt) {
		console.warn(
			`[getDocumentPrompt] Unknown document type: ${documentType}, using general prompt`,
		);
		return GENERAL_PROMPT;
	}
	return prompt;
}

/**
 * Get just the persona for a document type
 *
 * @param documentType - The type of document
 * @returns The expert persona description
 */
export function getDocumentPersona(documentType: DocumentType): string {
	return getDocumentPrompt(documentType).persona;
}

/**
 * Get the sections for a document type
 *
 * @param documentType - The type of document
 * @returns Array of section configurations
 */
export function getDocumentSections(documentType: DocumentType) {
	return getDocumentPrompt(documentType).sections;
}

/**
 * Get quality checklist for a document type
 *
 * @param documentType - The type of document
 * @returns Array of quality checklist items
 */
export function getQualityChecklist(documentType: DocumentType): string[] {
	return getDocumentPrompt(documentType).qualityChecklist;
}

/**
 * Get anti-patterns for a document type
 *
 * @param documentType - The type of document
 * @returns Array of anti-patterns to avoid
 */
export function getAntiPatterns(documentType: DocumentType): string[] {
	return getDocumentPrompt(documentType).antiPatterns;
}

/**
 * List all available document types
 */
export function listDocumentTypes(): DocumentType[] {
	return Object.keys(DOCUMENT_PROMPTS) as DocumentType[];
}

// Re-export individual prompts for direct access
export {
	PRD_PROMPT,
	PROPOSAL_PROMPT,
	ARCHITECTURE_PROMPT,
	TECHNICAL_SPEC_PROMPT,
	API_SPEC_PROMPT,
	USER_STORY_PROMPT,
	GENERAL_PROMPT,
};

// Re-export semantic section groups
export * from "./section-groups";
// Re-export feature document constants
export * from "./user-story-constants";
