/**
 * Temporal activities for prompt fetching and rendering
 * Used by document generation workflows to load dynamic prompts from the database
 */

import { getMarkdownFormattingRulesPrompt } from "@repo/agent-prompts";
import type { ProjectContext } from "@repo/agent-types";
import { buildRetrievedContextBlock } from "../lib/retrieved-context-block";

interface FetchPromptForAgentInput {
	agentName: string;
	userId: string;
	organizationId?: string;
	documentType: string;
}

interface FetchPromptForAgentOutput {
	promptId: string;
	promptName: string;
	promptVersionId: string;
	content: string;
	format: string;
	scope: "SYSTEM" | "ORG" | "USER";
}

interface RenderPromptWithContextInput {
	promptId: string;
	variables?: Record<string, any>;
	versionNumber?: number;
	projectContext?: ProjectContext;
	ragContexts?: string[];
	currentDocument?: string;
	userId?: string;
	organizationId?: string;
	/** Document type for template-specific override instructions */
	documentType?: string;
}

interface RenderPromptWithContextOutput {
	rendered: string;
	version: number;
	format: string;
}

/**
 * Fetch the bound prompt for an agent based on user/org/system precedence
 * Returns null if no prompt is bound (caller should use fallback)
 */
export async function fetchPromptForAgent(
	input: FetchPromptForAgentInput,
): Promise<FetchPromptForAgentOutput | null> {
	const { agentName, userId, organizationId, documentType } = input;

	// Use direct database query instead of API client (Temporal worker doesn't have access to @repo/api)
	const { getBoundPromptForAgent } = await import(
		"@repo/database/prisma/queries/prompts"
	);

	try {
		// Fetch bound prompt from database
		const prompt = await getBoundPromptForAgent({
			agentName,
			userId,
			organizationId,
			documentType,
		});

		if (!prompt) {
			console.warn(
				`[Temporal] No prompt bound for agent: ${agentName}, documentType: ${documentType}`,
			);
			return null;
		}

		return {
			promptId: prompt.id,
			promptName: prompt.name,
			promptVersionId: prompt.version.id,
			content: prompt.version.content,
			format: prompt.format,
			scope: prompt.scope,
		};
	} catch (error) {
		console.error(
			`[Temporal] Failed to fetch prompt for agent ${agentName}:`,
			error,
		);
		return null;
	}
}

/**
 * Render a prompt with variables and context injection
 * Handles template rendering and appends project context, RAG contexts, and current document
 */
export async function renderPromptWithContext(
	input: RenderPromptWithContextInput,
): Promise<RenderPromptWithContextOutput> {
	const {
		promptId,
		variables = {},
		versionNumber,
		projectContext,
		ragContexts,
		currentDocument,
		userId,
		organizationId,
	} = input;

	// Use direct database queries instead of API client
	const { getPromptById, incrementPromptUsage } = await import(
		"@repo/database/prisma/queries/prompts"
	);
	const { renderTemplate } = await import("@repo/utils/template-renderer");

	try {
		// Fetch prompt from database with tenant context for proper isolation
		const prompt = await getPromptById(promptId, {
			userId,
			organizationId,
		});
		if (!prompt) {
			throw new Error(`Prompt not found: ${promptId}`);
		}

		// Get the specific version or latest version
		const version = versionNumber
			? prompt.versions.find((v) => v.version === versionNumber)
			: prompt.versions[0]; // versions are ordered by version DESC

		if (!version) {
			throw new Error(
				`Prompt version not found: ${promptId}, version: ${versionNumber}`,
			);
		}

		// Render the template with variables
		const result = await renderTemplate({
			format: prompt.format as any,
			template: version.content,
			variables,
		});

		let finalRendered = result.rendered;

		// NOTE: Document-type-specific override instructions are NOT prepended here.
		// The user's custom prompt defines its own format and structure.
		// Format enforcement for non-custom-prompt cases is handled by the
		// unified prompt builder in @repo/agent-prompts.

		// CRITICAL: Add markdown formatting rules early in the prompt
		// This ensures the AI follows proper GFM table syntax and markdown structure
		const formattingRules = getMarkdownFormattingRulesPrompt();
		finalRendered += `\n\n${formattingRules}`;

		// Inject project context if provided
		// CRITICAL: When RAG contexts exist, they define the product scope - don't inject features
		// to avoid the AI building a PRD about generic wizard features instead of RAG content
		if (projectContext) {
			const hasRagContexts = ragContexts && ragContexts.length > 0;
			const contextStr = `
Project Context:
- Name: ${projectContext.name}
${projectContext.description ? `- Description: ${projectContext.description}` : ""}
${projectContext.goals ? `- Goals: ${projectContext.goals}` : ""}
${projectContext.techStack?.length ? `- Tech Stack: ${projectContext.techStack.join(", ")}` : ""}
${!hasRagContexts && projectContext.features?.length ? `- Features: ${projectContext.features.join(", ")}` : ""}
${projectContext.projectTypes?.length ? `- Project Types: ${projectContext.projectTypes.join(", ")}` : ""}`;
			finalRendered += contextStr;
		}

		// Inject RAG contexts if provided
		// NOTE: Format-specific reminders are NOT added here — the custom prompt
		// defines its own format. The unified builder handles format enforcement
		// for non-custom-prompt cases.
		if (ragContexts && ragContexts.length > 0) {
			finalRendered += buildRetrievedContextBlock(
				ragContexts,
				`## FINAL REMINDER

Extract CONTENT from the contexts above. Use the reference documents for content only, not for structure.`,
			);
		}

		// Inject current document state if provided
		if (currentDocument) {
			// Extract existing section headers to prevent duplicate sections
			const headingPattern = /^(#{2,3})\s+(.+)$/gm;
			const existingHeadings: string[] = [];
			for (
				let headingMatch = headingPattern.exec(currentDocument);
				headingMatch !== null;
				headingMatch = headingPattern.exec(currentDocument)
			) {
				existingHeadings.push(headingMatch[2].trim());
			}

			const headingsList =
				existingHeadings.length > 0
					? `\n\nSections that ALREADY EXIST in this document (DO NOT create duplicates):\n${existingHeadings.map((h) => `- ${h}`).join("\n")}\n\nIf editing, modify sections IN PLACE. Do NOT create a second copy of any section.`
					: "";

			const docStr = `

## Current Document State

This document already exists. When editing, preserve its content and modify sections in place.${headingsList}

----
${currentDocument}
----`;
			finalRendered += docStr;
		}

		// Track usage
		await incrementPromptUsage(prompt.id);

		return {
			rendered: finalRendered,
			version: version.version,
			format: prompt.format,
		};
	} catch (error) {
		console.error(`[Temporal] Failed to render prompt ${promptId}:`, error);
		throw error;
	}
}

/**
 * Fetch and render prompt in one step
 * Convenience function that combines fetchPromptForAgent and renderPromptWithContext
 */
export async function fetchAndRenderPrompt(input: {
	agentName: string;
	userId: string;
	organizationId?: string;
	documentType: string;
	variables?: Record<string, any>;
	projectContext?: ProjectContext;
	ragContexts?: string[];
	currentDocument?: string;
}): Promise<{
	rendered: string;
	promptId: string;
	promptName: string;
	promptVersionId: string;
	scope: string;
} | null> {
	// Fetch bound prompt
	const prompt = await fetchPromptForAgent({
		agentName: input.agentName,
		userId: input.userId,
		organizationId: input.organizationId,
		documentType: input.documentType,
	});

	if (!prompt) {
		return null;
	}

	// Render prompt with context
	const rendered = await renderPromptWithContext({
		promptId: prompt.promptId,
		variables: input.variables,
		projectContext: input.projectContext,
		ragContexts: input.ragContexts,
		currentDocument: input.currentDocument,
		userId: input.userId,
		organizationId: input.organizationId,
		documentType: input.documentType,
	});

	return {
		rendered: rendered.rendered,
		promptId: prompt.promptId,
		promptName: prompt.promptName,
		promptVersionId: prompt.promptVersionId,
		scope: prompt.scope,
	};
}

/**
 * Fetch and render a prompt by its key
 * Uses precedence: USER > ORG > SYSTEM
 * Returns the rendered prompt or null if not found (caller should use fallback)
 */
export async function fetchAndRenderPromptByKey(input: {
	promptKey: string;
	userId: string;
	organizationId?: string;
	variables?: Record<string, any>;
	projectContext?: ProjectContext;
	ragContexts?: string[];
	currentDocument?: string;
}): Promise<{
	rendered: string;
	promptId: string;
	promptName: string;
	scope: string;
} | null> {
	const {
		promptKey,
		userId,
		organizationId,
		variables,
		projectContext,
		ragContexts,
		currentDocument,
	} = input;

	// Use direct database queries
	const { getPromptByKey, incrementPromptUsage } = await import(
		"@repo/database/prisma/queries/prompts"
	);
	const { renderTemplate } = await import("@repo/utils/template-renderer");

	try {
		// Fetch prompt by key with precedence
		const prompt = await getPromptByKey({
			key: promptKey,
			userId,
			organizationId,
		});

		if (!prompt || !prompt.versions[0]) {
			console.warn(`[Temporal] No prompt found for key: ${promptKey}`);
			return null;
		}

		const version = prompt.versions[0];

		// Render the template with variables
		const result = await renderTemplate({
			format: prompt.format as any,
			template: version.content,
			variables: variables || {},
		});

		let finalRendered = result.rendered;

		// CRITICAL: Add markdown formatting rules early in the prompt
		// This ensures the AI follows proper GFM table syntax and markdown structure
		const formattingRules = getMarkdownFormattingRulesPrompt();
		finalRendered += `\n\n${formattingRules}`;

		// Inject project context if provided
		// CRITICAL: When RAG contexts exist, they define the product scope - don't inject features
		// to avoid the AI building a PRD about generic wizard features instead of RAG content
		if (projectContext) {
			const hasRagContexts = ragContexts && ragContexts.length > 0;
			const contextStr = `

Project Context:
- Name: ${projectContext.name}
${projectContext.description ? `- Description: ${projectContext.description}` : ""}
${projectContext.goals ? `- Goals: ${projectContext.goals}` : ""}
${projectContext.techStack?.length ? `- Tech Stack: ${projectContext.techStack.join(", ")}` : ""}
${!hasRagContexts && projectContext.features?.length ? `- Features: ${projectContext.features.join(", ")}` : ""}
${projectContext.projectTypes?.length ? `- Project Types: ${projectContext.projectTypes.join(", ")}` : ""}`;
			finalRendered += contextStr;
		}

		// Inject RAG contexts if provided (generic reminder - this function doesn't have document type)
		if (ragContexts && ragContexts.length > 0) {
			finalRendered += buildRetrievedContextBlock(
				ragContexts,
				`## FINAL REMINDER

The contexts above are for CONTENT EXTRACTION ONLY. Follow the document template structure, not the structure of the reference contexts.`,
			);
		}

		// Inject current document state if provided
		if (currentDocument) {
			// Extract existing section headers to prevent duplicate sections
			const headingPattern = /^(#{2,3})\s+(.+)$/gm;
			const existingHeadings: string[] = [];
			for (
				let headingMatch = headingPattern.exec(currentDocument);
				headingMatch !== null;
				headingMatch = headingPattern.exec(currentDocument)
			) {
				existingHeadings.push(headingMatch[2].trim());
			}

			const headingsList =
				existingHeadings.length > 0
					? `\n\nSections that ALREADY EXIST in this document (DO NOT create duplicates):\n${existingHeadings.map((h) => `- ${h}`).join("\n")}\n\nIf editing, modify sections IN PLACE. Do NOT create a second copy of any section.`
					: "";

			const docStr = `

## Current Document State

This document already exists. When editing, preserve its content and modify sections in place.${headingsList}

----
${currentDocument}
----`;
			finalRendered += docStr;
		}

		// Track usage
		await incrementPromptUsage(prompt.id);

		return {
			rendered: finalRendered,
			promptId: prompt.id,
			promptName: prompt.name,
			scope: prompt.scope,
		};
	} catch (error) {
		console.error(
			`[Temporal] Failed to fetch/render prompt by key ${promptKey}:`,
			error,
		);
		return null;
	}
}
