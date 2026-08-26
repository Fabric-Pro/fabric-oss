/**
 * @repo/agent-prompts
 *
 * Centralized prompt generation for agents.
 * These prompts are framework and language-agnostic.
 */
import { DOCUMENT_TYPES } from "@repo/agent-types";
/**
 * Get system prompt for a specific document type
 * Works with agents in any language (TypeScript, Python, C#)
 */
export function getSystemPromptForDocumentType(documentType) {
	const metadata = DOCUMENT_TYPES[documentType];
	if (documentType === "general") {
		return `You are an AI assistant that helps users write and edit documents.
Generate clear, well-structured content based on the user's request.
Use markdown formatting for better readability.`;
	}
	// Safety check: If metadata is not found, return a generic prompt
	if (!metadata) {
		console.warn(
			`[getSystemPromptForDocumentType] Unknown document type: ${documentType}, using fallback prompt`,
		);
		return `You are an AI assistant that helps users write ${documentType.replace(/_/g, " ")} documents.
Generate clear, well-structured content based on the user's request.
Use markdown formatting with clear section headers.
Be concise but comprehensive and ensure the document is professional and well-organized.`;
	}
	return `You are an AI assistant that helps users write ${metadata.name} documents.

Document Structure:
${metadata.sections.map((section, index) => `${index + 1}. ${section}`).join("\n")}

Guidelines:
- Generate content following the structure above
- Use markdown formatting with clear section headers (## for main sections)
- Be concise but comprehensive
- Include relevant details for each section
- Use bullet points and numbered lists where appropriate
- Ensure the document is professional and well-organized

When generating the document, include all sections with appropriate content based on the user's request.`;
}
/**
 * Get system prompt for project documents
 * Includes project context and RAG-retrieved knowledge
 */
export function getSystemPromptForProjectDocument(
	documentType,
	projectContext,
	ragContexts = [],
) {
	const basePrompt = getSystemPromptForDocumentType(documentType);
	const projectInfo = `
Project Context:
- Name: ${projectContext.name}
${projectContext.description ? `- Description: ${projectContext.description}` : ""}
${projectContext.goals ? `- Goals: ${projectContext.goals}` : ""}
${projectContext.techStack.length > 0 ? `- Tech Stack: ${projectContext.techStack.join(", ")}` : ""}
${projectContext.features.length > 0 ? `- Features: ${projectContext.features.join(", ")}` : ""}
${projectContext.projectType ? `- Project Type: ${projectContext.projectType}` : ""}
`;
	const ragInfo =
		ragContexts.length > 0
			? `
Retrieved Knowledge:
${ragContexts.map((ctx, i) => `${i + 1}. ${ctx}`).join("\n")}
`
			: "";
	return `${basePrompt}

${projectInfo}
${ragInfo}

Use the project context and retrieved knowledge to generate a relevant, accurate document that aligns with the project's goals and technical details.`;
}
/**
 * Get document writing instructions
 * These instructions are appended to the system prompt
 */
export function getDocumentWritingInstructions(currentDocument) {
	return `
To write the document, you MUST use the write_document_local tool.
You MUST write the full document, even when changing only a few words.
When you wrote the document, DO NOT repeat it as a message.
Just briefly summarize the changes you made. 2 sentences max.

Current document state:
----
${currentDocument || "(empty)"}
----
`;
}
//# sourceMappingURL=index.js.map
