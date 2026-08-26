/**
 * System Prompt Builder
 *
 * Assembles complete system prompts from modular components.
 * This is the main entry point for building document generation prompts.
 */

import type { DocumentType, ProjectContext } from "@repo/agent-types";
import { getBaseInstructions } from "../core/base-instructions";
import { RAG_USAGE_INSTRUCTIONS } from "../core/rag-instructions";
import { buildToolInstructions } from "../core/tool-instructions";
import { getDocumentPrompt } from "../documents";
import type {
	BuildSystemPromptOptions,
	BuiltPrompt,
	DocumentPromptConfig,
	QualityTier,
} from "../types";
import {
	formatProjectContext,
	formatRagContextsSimple,
} from "./context-formatter";

/**
 * Build a complete system prompt for document generation
 *
 * This function assembles all the components:
 * 1. Expert persona and quality tier instructions
 * 2. Document structure with section guidance
 * 3. Quality standards and anti-patterns
 * 4. Project context
 * 5. RAG context with usage instructions
 * 6. Tool usage instructions
 *
 * @param options - Build options
 * @returns Complete system prompt
 */
export function buildSystemPrompt(
	options: BuildSystemPromptOptions,
): BuiltPrompt {
	const {
		documentType,
		projectContext,
		ragContexts,
		existingDocument,
		hasCopilotKitActions = true,
		qualityTier = "standard",
		customPrompt,
	} = options;

	// If custom prompt provided, use it with tool instructions
	if (customPrompt) {
		const toolInstructions = buildToolInstructions(
			existingDocument,
			hasCopilotKitActions,
		);

		return {
			prompt: `${customPrompt}\n\n---\n\n${toolInstructions}`,
			documentType,
			qualityTier,
			usedCustomPrompt: true,
		};
	}

	// Get document-specific configuration
	const docConfig = getDocumentPrompt(documentType);

	// Build prompt sections
	const sections: string[] = [];

	// 1. Expert persona and base instructions
	sections.push(buildPersonaSection(docConfig, qualityTier));

	// 2. Document structure with section guidance
	sections.push(buildStructureSection(docConfig));

	// 3. Quality standards
	sections.push(buildQualitySection(docConfig));

	// 4. Project context
	sections.push(formatProjectContext(projectContext));

	// 5. RAG context (if available)
	if (ragContexts && ragContexts.length > 0) {
		sections.push(buildRagSection(ragContexts));
	}

	// 6. Tool instructions
	sections.push(
		buildToolInstructions(existingDocument, hasCopilotKitActions),
	);

	// Join all sections with dividers
	const prompt = sections.join("\n\n---\n\n");

	return {
		prompt,
		documentType,
		qualityTier,
		usedCustomPrompt: false,
	};
}

/**
 * Build the persona and base instructions section
 */
function buildPersonaSection(
	docConfig: DocumentPromptConfig,
	qualityTier: QualityTier,
): string {
	const baseInstructions = getBaseInstructions(qualityTier);

	return `# Role

${docConfig.persona}

${baseInstructions}`;
}

/**
 * Build the document structure section
 */
function buildStructureSection(docConfig: DocumentPromptConfig): string {
	const sections = docConfig.sections.map((section, i) => {
		const required = section.required ? "(Required)" : "(Optional)";
		let content = `### ${i + 1}. ${section.name} ${required}\n\n${section.guidance}`;

		// Add example if available
		if (section.example) {
			content += `\n\n**Example:**\n${section.example}`;
		}

		return content;
	});

	return `# Document Structure

Generate a document with the following sections:

${sections.join("\n\n")}`;
}

/**
 * Build the quality standards section
 */
function buildQualitySection(docConfig: DocumentPromptConfig): string {
	const checklist = docConfig.qualityChecklist
		.map((item) => `- ✓ ${item}`)
		.join("\n");

	const antiPatterns = docConfig.antiPatterns
		.map((item) => `- ✗ ${item}`)
		.join("\n");

	let content = `# Quality Standards

## Before Finalizing, Verify:
${checklist}

## Avoid These Anti-Patterns:
${antiPatterns}`;

	// Add examples if available
	if (docConfig.examples && Object.keys(docConfig.examples).length > 0) {
		const examples = Object.entries(docConfig.examples)
			.map(
				([name, example]) =>
					`### ${formatExampleName(name)}\n\`\`\`\n${example}\n\`\`\``,
			)
			.join("\n\n");

		content += `\n\n## Reference Examples\n\n${examples}`;
	}

	// Add additional instructions if available
	if (docConfig.additionalInstructions) {
		content += `\n\n${docConfig.additionalInstructions}`;
	}

	return content;
}

/**
 * Build the RAG context section
 */
function buildRagSection(ragContexts: string[]): string {
	const formattedContexts = formatRagContextsSimple(ragContexts);

	return `${RAG_USAGE_INSTRUCTIONS}

${formattedContexts}`;
}

/**
 * Format example name from camelCase to Title Case
 */
function formatExampleName(name: string): string {
	return name
		.replace(/([A-Z])/g, " $1")
		.replace(/^./, (str) => str.toUpperCase())
		.trim();
}

/**
 * Build a minimal prompt (for quick drafts or simple requests)
 *
 * @param documentType - Type of document
 * @param projectContext - Project context
 * @returns Minimal prompt string
 */
export function buildMinimalPrompt(
	documentType: DocumentType,
	projectContext: ProjectContext,
): string {
	const docConfig = getDocumentPrompt(documentType);
	const sectionNames = docConfig.sections
		.filter((s) => s.required)
		.map((s) => s.name)
		.join(", ");

	return `You are a ${docConfig.name} writer.

Generate a ${docConfig.name} for: ${projectContext.name}
${projectContext.description ? `Description: ${projectContext.description}` : ""}
${projectContext.goals ? `Goals: ${projectContext.goals}` : ""}

Include these sections: ${sectionNames}

Use markdown formatting with proper headings.`;
}

/**
 * Get just the document structure guidance
 * (useful for UI display or partial prompts)
 *
 * @param documentType - Type of document
 * @returns Structure guidance string
 */
export function getStructureGuidance(documentType: DocumentType): string {
	const docConfig = getDocumentPrompt(documentType);
	return buildStructureSection(docConfig);
}

/**
 * Get the quality checklist for a document type
 * (useful for validation or UI display)
 *
 * @param documentType - Type of document
 * @returns Quality checklist string
 */
export function getQualityGuidance(documentType: DocumentType): string {
	const docConfig = getDocumentPrompt(documentType);
	return buildQualitySection(docConfig);
}
