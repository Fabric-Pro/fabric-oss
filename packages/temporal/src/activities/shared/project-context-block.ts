/**
 * Project Context Block Builder
 *
 * Loads project metadata and formats it into the `<project_context>` block
 * injected into agent system prompts. Shared across the direct-chat runtime
 * (chat UI) and the trigger-system runtime (Slack-triggered agents) so all
 * project-aware agents present consistent context to the LLM.
 */

import { formatContextAvailabilityText } from "@repo/database";
import { log } from "@temporalio/activity";
import { formatRepositoryRoleMap } from "../../lib/repository-role-formatter";
import { getProjectMetadataActivity } from "../project-metadata";

export async function buildProjectContextBlock(
	projectId: string,
	tenant: { userId: string; organizationId?: string | null },
): Promise<string | null> {
	try {
		const meta = await getProjectMetadataActivity(projectId, tenant);
		if (!meta) {
			return null;
		}

		const availability = formatContextAvailabilityText({
			hasCodebase: meta.hasCodeAnalysis,
			codebaseState: meta.codebaseState,
			transcriptCount: meta.transcriptCount,
			fileCount: meta.fileCount,
			integrationCount: meta.integrationCount,
			teamsCount: meta.teamsCount,
			slackCount: meta.slackCount,
			websiteSources: meta.websiteSources,
		});

		const toolGuidanceParts = [
			"Use project_rag_query for documents, transcripts, code analysis, and other embedded project context.",
		];
		if (meta.slackCount > 0) {
			toolGuidanceParts.push(
				`This project has ${meta.slackCount} Slack channel(s) linked. Use search_slack_messages whenever the user asks about Slack content, discussions, recent activity, or what is set up — Slack messages are NOT indexed in project_rag_query (which only returns pointer rows for integrations). Never report that Slack is "empty" without first calling search_slack_messages to verify.`,
			);
		}
		if (meta.teamsCount > 0) {
			toolGuidanceParts.push(
				`This project has ${meta.teamsCount} Microsoft Teams chat(s)/channel(s) linked. Use search_teams_messages whenever the user asks about Teams content, discussions, recent activity, or what is set up — Teams messages are NOT indexed in project_rag_query. Never report that Teams is "empty" without first calling search_teams_messages to verify.`,
			);
		}

		const repoBlock = meta.repositoryRoles?.length
			? formatRepositoryRoleMap(meta.repositoryRoles)
			: null;

		const lines: (string | null)[] = [
			"<project_context>",
			`Project: ${meta.name}`,
			meta.description ? `Description: ${meta.description}` : null,
			meta.goals ? `Goals: ${meta.goals}` : null,
			meta.techStack?.length
				? `Tech Stack: ${meta.techStack.join(", ")}`
				: null,
			meta.features?.length
				? `Features: ${meta.features.join(", ")}`
				: null,
			repoBlock,
			"",
			...availability.split("\n"),
			"",
			"Instructions:",
			"- For technical, implementation, architecture, or behavior-related questions, the attached codebase is the MOST AUTHORITATIVE source. When both documentation and codebase context are available, defer to what the code actually shows.",
			"- When multiple codebases or repositories are connected (e.g. tagged with roles like Legacy, Primary, V1, V2), explicitly attribute implementations and findings to each respective codebase and clarify differences between them.",
			"- If the codebase does not contain enough information to answer confidently, supplement with other available project context and clearly indicate uncertainty or gaps.",
			"- For questions about decisions, discussions, blockers, requirements, or action items, use synced Teams/Slack chat messages and meeting transcripts as supporting context. When both chat history and transcripts contain related context, synthesize across both sources into a single coherent answer.",
			"- Meeting transcripts (MEETING_TRANSCRIPT) capture call decisions and outcomes. Teams/Slack integration data captures async discussions. Cite each source explicitly.",
			"- If the user asks about something requiring a context type listed as NOT AVAILABLE, relay the specific reason shown in Context Sources verbatim — for example, that a repository IS connected but its credentials expired (re-authentication needed) or that its code is still indexing. Only say no repository is connected when Context Sources actually shows the codebase as not connected; never claim a repository is missing when one is attached.",
			"- When citing project context, mention the source type (e.g., codebase analysis, meeting transcript, Teams/Slack discussion, uploaded document).",
			"",
			"Document Generation:",
			"- When generating or updating documents, use combined context from all available sources to produce accurate, complete drafts.",
			"- When multiple codebases are present with role tags, clearly identify which codebase specific requirements, models, APIs, or legacy constraints originate from.",
			"- Synthesize information into coherent prose rather than listing disconnected summaries from each source.",
			"- If context sources contain conflicting details, resolve by deferring to the most authoritative source (codebase for technical details, meeting transcripts for decisions). If unresolvable, flag the inconsistency for review.",
			"",
			"Transparency & Accuracy:",
			"- When no relevant project context is found for a question, state that your answer is based on limited context rather than implying high confidence.",
			"- Do NOT fabricate project-specific facts, decisions, code details, or meeting outcomes not grounded in provided context. If uncertain, say so clearly.",
			"- When your response draws on multiple source types, briefly note which sources informed your answer.",
			"",
			`Available contexts: ${meta.contextCount}, Generated documents: ${meta.documentCount}`,
			toolGuidanceParts.join(" "),
			"</project_context>",
		];

		return lines.filter(Boolean).join("\n");
	} catch (error) {
		log.warn("[shared/project-context-block] Failed to build block", {
			projectId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}
