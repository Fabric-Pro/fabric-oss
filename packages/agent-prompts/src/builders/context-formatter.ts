/**
 * Context Formatter
 *
 * Formats project context and RAG contexts for prompt injection.
 * Designed for clarity and easy parsing by LLMs.
 */

import type { ProjectContext } from "@repo/agent-types";
import type { FormattedContext } from "../types";

/**
 * Format project context for prompt injection
 *
 * Creates a well-structured, readable representation of project metadata.
 *
 * @param ctx - Project context object
 * @returns Formatted project context section
 */
export function formatProjectContext(ctx: ProjectContext): string {
	const sections: string[] = [];

	// Project name is always present
	sections.push(`**Project Name:** ${ctx.name}`);

	// Description
	if (ctx.description) {
		sections.push(`**Description:**\n${ctx.description}`);
	}

	// Goals
	if (ctx.goals) {
		sections.push(`**Goals & Objectives:**\n${ctx.goals}`);
	}

	// Tech stack
	if (ctx.techStack && ctx.techStack.length > 0) {
		const techList = ctx.techStack.map((t) => `- ${t}`).join("\n");
		sections.push(`**Technology Stack:**\n${techList}`);
	}

	// Features
	if (ctx.features && ctx.features.length > 0) {
		const featureList = ctx.features
			.map((f, i) => `${i + 1}. ${f}`)
			.join("\n");
		sections.push(`**Key Features:**\n${featureList}`);
	}

	// Project types
	if (ctx.projectTypes && ctx.projectTypes.length > 0) {
		sections.push(`**Project Types:** ${ctx.projectTypes.join(", ")}`);
	}

	// Repository
	if (ctx.repositoryUrl) {
		const repoInfo =
			ctx.repositoryOwner && ctx.repositoryName
				? `${ctx.repositoryOwner}/${ctx.repositoryName}`
				: ctx.repositoryUrl;
		const branch = ctx.defaultBranch || "main";
		sections.push(
			`**Repository:** ${repoInfo} (branch: ${branch})\n**Repository URL:** ${ctx.repositoryUrl}`,
		);
	}

	return `## Project Context

${sections.join("\n\n")}`;
}

/**
 * Format project context in a compact form (for shorter prompts)
 *
 * @param ctx - Project context object
 * @returns Compact formatted context
 */
export function formatProjectContextCompact(ctx: ProjectContext): string {
	const parts: string[] = [];

	parts.push(`Project: ${ctx.name}`);

	if (ctx.description) {
		parts.push(`Description: ${ctx.description}`);
	}

	if (ctx.goals) {
		parts.push(`Goals: ${ctx.goals}`);
	}

	if (ctx.techStack && ctx.techStack.length > 0) {
		parts.push(`Tech Stack: ${ctx.techStack.join(", ")}`);
	}

	if (ctx.features && ctx.features.length > 0) {
		parts.push(`Features: ${ctx.features.join(", ")}`);
	}

	if (ctx.projectTypes && ctx.projectTypes.length > 0) {
		parts.push(`Types: ${ctx.projectTypes.join(", ")}`);
	}

	if (ctx.repositoryUrl) {
		const repoInfo =
			ctx.repositoryOwner && ctx.repositoryName
				? `${ctx.repositoryOwner}/${ctx.repositoryName}`
				: ctx.repositoryUrl;
		parts.push(`Repository: ${repoInfo} (${ctx.defaultBranch || "main"})`);
	}

	return parts.join("\n");
}

/**
 * Format RAG contexts with metadata
 *
 * @param contexts - Array of contexts with metadata
 * @returns Formatted context section
 */
export function formatRagContextsWithMetadata(
	contexts: FormattedContext[],
): string {
	if (!contexts || contexts.length === 0) {
		return "";
	}

	const formattedContexts = contexts.map((ctx, i) => {
		const header = buildContextHeader(ctx, i);
		return `${header}\n${ctx.content}`;
	});

	return `## Retrieved Context

The following information was retrieved from the project's knowledge base.
Use this to inform your document while maintaining consistency with established decisions.

${formattedContexts.join("\n\n---\n\n")}`;
}

/**
 * How an entry announces that the user attached it *this turn*.
 *
 * The distinction is load-bearing: attached files are rendered with stronger,
 * more accurate instructions than retrieved KB chunks ("you have already read
 * every word inline; cite as 'the attached X', never tell the user to 'see' or
 * 'open' the file"). Without it the model treats inline attachment text as a
 * remote citation and writes "see angular-test.pdf" / "use the PDF" prose.
 *
 * Two shapes are accepted, and that is deliberate rather than transitional
 * sloppiness. The producers ship through the web deploy while this router ships
 * inside the agent images, on two independent workflows off the same tag. The
 * web side finishes in minutes while the images rebuild, so a single-shape
 * router guarantees a window in which every attachment in flight is routed to
 * the retrieved bucket and described to the model as a document that exists
 * somewhere else. Rag contexts persisted before the change have the same
 * problem afterward.
 *
 * Dropping the legacy branch is a named follow-up, not a cleanup to do here.
 */
const ATTACHMENT_ENVELOPE_OPEN = "<fabric_attachment>";
const LEGACY_ATTACHED_DOCUMENT_PREFIX = "[Uploaded Document:";
const LEGACY_ATTACHED_IMAGE_PREFIX = "[Uploaded Image:";

function isAttachedFileEntry(ctx: string): boolean {
	const trimmed = ctx.trimStart();
	// Exact, case-sensitive match on the tag. The producer emits one spelling,
	// so leniency here would only widen what a persisted chunk can claim about
	// itself.
	return (
		trimmed.startsWith(ATTACHMENT_ENVELOPE_OPEN) ||
		trimmed.startsWith(LEGACY_ATTACHED_DOCUMENT_PREFIX) ||
		trimmed.startsWith(LEGACY_ATTACHED_IMAGE_PREFIX)
	);
}

/**
 * Format RAG contexts (simple string array)
 *
 * @param contexts - Array of context content strings
 * @returns Formatted context section
 */
export function formatRagContextsSimple(contexts: string[]): string {
	if (!contexts || contexts.length === 0) {
		return "";
	}

	// Split contexts into user-attached files vs retrieved KB / Teams entries.
	// They get different headings + instructions because they have different
	// semantics: attached files are inline content the user just shared in
	// THIS turn (cannot be linked to or "opened"), while retrieved entries
	// are knowledge-base citations from prior project state.
	const attachedEntries: string[] = [];
	const retrievedEntries: string[] = [];
	for (const ctx of contexts) {
		if (isAttachedFileEntry(ctx)) {
			attachedEntries.push(ctx);
		} else {
			retrievedEntries.push(ctx);
		}
	}

	const sections: string[] = [];

	if (attachedEntries.length > 0) {
		const formattedAttached = attachedEntries
			.map((ctx, i) => `### Attachment ${i + 1}\n${ctx}`)
			.join("\n\n");
		sections.push(`## Files Attached This Turn

The following files were attached by the user in their current message. Their
full content is included inline below — you have already read every word.

When you reference an attached file, use phrasing such as:
  - "based on the attached <filename>"
  - "the attached <filename> describes…"
  - "according to the attached <filename>"

Do NOT tell the user to "see", "open", "view", or "use" the attached file —
the chat surface does not render or link to attachments, so any phrasing that
implies the user must follow up to read the file is incorrect. The text below
is the file content itself.

${formattedAttached}`);
	}

	if (retrievedEntries.length > 0) {
		const formattedRetrieved = retrievedEntries
			.map((ctx, i) => `### Reference ${i + 1}\n${ctx}`)
			.join("\n\n");
		sections.push(`## Retrieved Context

The following information was retrieved from the project's knowledge base.
Use this to inform your document while maintaining consistency with established decisions.

${formattedRetrieved}`);
	}

	return sections.join("\n\n");
}

/**
 * Build header for a context entry
 */
function buildContextHeader(ctx: FormattedContext, index: number): string {
	const parts: string[] = [];

	// Source name
	const source = ctx.filename || `Context ${index + 1}`;
	parts.push(`### ${source}`);

	// Metadata line
	const meta: string[] = [];
	if (ctx.type) {
		meta.push(`Type: ${ctx.type}`);
	}
	if (ctx.score !== undefined) {
		meta.push(`Relevance: ${(ctx.score * 100).toFixed(0)}%`);
	}

	if (meta.length > 0) {
		parts.push(`*${meta.join(" | ")}*`);
	}

	return parts.join("\n");
}

/**
 * Context availability information for a project
 */
export interface ContextAvailability {
	hasCodebase: boolean;
	transcriptCount: number;
	fileCount: number;
	integrationCount: number;
	teamsCount: number;
	slackCount: number;
}

/**
 * Format context availability for prompt injection
 *
 * Produces a structured block that tells the AI which context types
 * are available vs unavailable for the project, so it can inform
 * users when requested context (e.g., codebase) is missing.
 *
 * @param availability - Context availability counts
 * @returns Formatted availability section
 */
export function formatContextAvailability(
	availability: ContextAvailability,
): string {
	const available: string[] = [];
	const unavailable: string[] = [];

	if (availability.hasCodebase) {
		available.push("Codebase analysis (attached repository)");
	} else {
		// This document-generation path doesn't carry the discriminated codebase
		// state, so report the neutral "not connected" reason. See
		// `formatContextAvailabilityText` in @repo/database for the state-aware
		// formatter that distinguishes expired / not-indexed / disabled.
		unavailable.push("Codebase (no repository connected)");
	}

	if (availability.transcriptCount > 0) {
		available.push(
			`Meeting transcripts (${availability.transcriptCount} synced)`,
		);
	} else {
		unavailable.push("Meeting transcripts (none synced)");
	}

	if (availability.fileCount > 0) {
		available.push(
			`Project files and documents (${availability.fileCount})`,
		);
	}

	if (availability.teamsCount > 0) {
		available.push("Teams chat conversations");
	} else {
		unavailable.push("Teams chat (not connected)");
	}

	if (availability.slackCount > 0) {
		available.push("Slack channel conversations");
	} else {
		unavailable.push("Slack chat (not connected)");
	}

	const otherIntegrations =
		availability.integrationCount -
		availability.teamsCount -
		availability.slackCount;
	if (otherIntegrations > 0) {
		available.push(`Other integrations (${otherIntegrations} sources)`);
	}

	const lines = [
		"Context Sources:",
		available.length > 0
			? `AVAILABLE: ${available.join(", ")}`
			: "No project context sources attached.",
		unavailable.length > 0
			? `NOT AVAILABLE: ${unavailable.join(", ")}`
			: "",
	].filter(Boolean);

	// Add authoritative source guidance when codebase is available
	if (availability.hasCodebase) {
		lines.push(
			"",
			"The attached codebase is the MOST AUTHORITATIVE source for technical, implementation, and architecture questions. When both documentation and codebase context are available, defer to the code. If the codebase does not contain enough information, supplement with other context and indicate uncertainty.",
		);
	}

	// Add synthesis guidance when transcripts/integrations are available
	if (availability.transcriptCount > 0) {
		lines.push(
			"",
			"For questions about decisions, discussions, blockers, requirements, or action items, use meeting transcripts and Teams/Slack chat messages as supporting context. When both sources contain related information, synthesize them into a single coherent answer and cite each source explicitly.",
		);
	}

	// Add document generation and conflict resolution guidance
	lines.push(
		"",
		"Document Generation: Synthesize information from all available sources into coherent prose. If sources conflict, defer to the most authoritative (codebase for technical details, transcripts for decisions) or flag the inconsistency for review.",
		"",
		"Transparency: When no relevant context is found, state that the answer is based on limited context. Do NOT fabricate project-specific facts not grounded in available context. When drawing on multiple source types, note which sources informed the answer.",
	);

	return lines.join("\n");
}

/**
 * Episodic memory result structure for formatting
 */
interface EpisodicMemoryContext {
	/** Episode title */
	title: string;
	/** Episode summary */
	summary: string;
	/** Key topics discussed */
	keyTopics: string[];
	/** Relevance score (0-1) */
	similarity: number;
	/** Optional conversation date */
	date?: string;
}

/**
 * Format episodic memories for prompt injection
 *
 * Formats past project discussions to provide context about
 * previous decisions and conversations related to the project.
 *
 * @param episodes - Array of episodic memory results
 * @returns Formatted episodic memory section
 */
function formatEpisodicMemories(episodes: EpisodicMemoryContext[]): string {
	if (!episodes || episodes.length === 0) {
		return "";
	}

	const formattedEpisodes = episodes.map((ep, index) => {
		const parts: string[] = [];

		parts.push(`### Past Discussion ${index + 1}: ${ep.title}`);

		// Add metadata line
		const meta: string[] = [];
		if (ep.keyTopics && ep.keyTopics.length > 0) {
			meta.push(`Topics: ${ep.keyTopics.join(", ")}`);
		}
		if (ep.similarity !== undefined) {
			meta.push(`Relevance: ${(ep.similarity * 100).toFixed(0)}%`);
		}
		if (ep.date) {
			meta.push(`Date: ${ep.date}`);
		}
		if (meta.length > 0) {
			parts.push(`*${meta.join(" | ")}*`);
		}

		parts.push(ep.summary);

		return parts.join("\n");
	});

	return `## Past Project Discussions

The following are summaries of relevant past conversations about this project.
Use these to maintain consistency with previous decisions and discussions:

${formattedEpisodes.join("\n\n---\n\n")}`;
}

/**
 * Combine project context and RAG contexts
 *
 * @param projectContext - Project context object
 * @param ragContexts - RAG contexts (strings or with metadata)
 * @param episodicMemories - Optional episodic memory contexts
 * @returns Combined context section
 */
export function formatAllContext(
	projectContext: ProjectContext,
	ragContexts: string[] | FormattedContext[],
	episodicMemories?: EpisodicMemoryContext[],
): string {
	const sections: string[] = [];

	// Add project context
	sections.push(formatProjectContext(projectContext));

	// Add RAG contexts
	if (ragContexts && ragContexts.length > 0) {
		// Check if it's string array or FormattedContext array
		if (typeof ragContexts[0] === "string") {
			sections.push(formatRagContextsSimple(ragContexts as string[]));
		} else {
			sections.push(
				formatRagContextsWithMetadata(
					ragContexts as FormattedContext[],
				),
			);
		}
	}

	// Add episodic memories (past project discussions)
	if (episodicMemories && episodicMemories.length > 0) {
		sections.push(formatEpisodicMemories(episodicMemories));
	}

	return sections.join("\n\n---\n\n");
}
