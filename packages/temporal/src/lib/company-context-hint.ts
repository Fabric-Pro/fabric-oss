/**
 * The one line that tells an Advisor chat which organization it works for and
 * that its company context can be searched. Kept apart from the search tool so
 * the Orchestrator preload can build the hint without loading the tool and its
 * model and search dependencies.
 */
import { neutralizeAiChatAttachmentFilename } from "@repo/utils/ai-chat-attachment";
import { COMPANY_CONTEXT_SEARCH_TOOL_NAME } from "../workflows/orchestrator/company-context-tool-schemas";
/**
 * The capabilities line telling the model which organization the chat works
 * for and that its company context can be searched. The name is the
 * organization's own text, so it is quoted as data: one line, no way out of
 * its quotes.
 */
export function companyContextHintLine(organizationName: string): string {
	const name = JSON.stringify(
		neutralizeAiChatAttachmentFilename(organizationName)
			.replace(/\s+/g, " ")
			.trim(),
	);
	return `- This chat works for the organization ${name}. Its own company context (capabilities, case studies, positioning) can be searched with ${COMPANY_CONTEXT_SEARCH_TOOL_NAME} when a question is about the organization; an answer that uses it must name the sources it drew on.`;
}
