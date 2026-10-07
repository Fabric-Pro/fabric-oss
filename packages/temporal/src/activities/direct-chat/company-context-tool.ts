/**
 * The Advisor's company-context search tool (Fizzy #2719).
 *
 * A Direct-mode Advisor chat can look up the organization's own company
 * context — capabilities, case studies, positioning — when a member asks
 * about the organization. Only the Advisor's stream route opts a turn in
 * (`companyContextAdvisor`): the same activity also writes replies into
 * project comments, which project guests read, and serves the meeting agent,
 * so nothing else may reach it. Without the opt-in the builder builds
 * nothing, so a caller that lists tools by name cannot reach it either.
 *
 * The turn decides once whether to offer the tool and the hint; every call
 * asks the access resolver again, so a membership or gate change in between
 * takes effect at the next call. A call returns the shared search's entries —
 * vendor-marked, each with its source's guidance, neutralized exactly as
 * generation gets them — wrapped as untrusted retrieved context, with the
 * source names an answer cites.
 */

import { tool } from "@repo/ai";
import { getDefaultRagSettings, getProjectRagSettings } from "@repo/database";
import { logger } from "@repo/logs";
import { resolveCompanyContextChatAccess } from "../../lib/company-context-chat-access";
import { searchCompanyContext } from "../../lib/company-context-search";
import {
	COMPANY_CONTEXT_SEARCH_DESCRIPTION,
	COMPANY_CONTEXT_SEARCH_INPUT_SCHEMA,
	COMPANY_CONTEXT_SEARCH_TOOL_NAME,
} from "../../workflows/orchestrator/company-context-tool-schemas";
import { jsonSchemaToZod } from "../orchestrator/utils";
import {
	UNTRUSTED_CONTEXT_GUIDANCE,
	wrapUntrustedContext,
} from "./untrusted-context";

/**
 * How long a chat waits for one search. Generation can wait longer; a chat
 * answers without company context rather than keep the person waiting.
 */
export const COMPANY_CONTEXT_SEARCH_TIMEOUT_MS = 6000;

/** Sent with a result that has context, since no prompt-time block may carry the guidance. */
const RESULT_GUIDANCE = `${UNTRUSTED_CONTEXT_GUIDANCE}\nAn answer that uses this material must name the sources it drew on, as listed in sources.`;

const TIMEOUT_NOTICE =
	"The company context search took too long and was skipped. Answer without it, or try once more with a shorter query.";

interface CompanyContextToolResult {
	/** The names of the sources `context` came from, for the answer to cite. */
	sources: string[];
	/** The matched material, wrapped as untrusted retrieved context; empty when there is none. */
	context: string;
	/** How to treat `context`; present only when there is some. */
	guidance?: string;
	/** Why the result is empty, when the search ran out of time. */
	notice?: string;
}

interface CompanyContextToolOptions {
	/**
	 * The Advisor's opt-in (`DirectChatWorkflowInput.companyContextAdvisor`).
	 * Anything but `true` builds nothing.
	 */
	companyContextAdvisor?: boolean;
	userId: string;
	/** The organization the request names; a project's organization wins. */
	organizationId?: string;
	projectId?: string;
}

function emptyResult(notice?: string): CompanyContextToolResult {
	return notice
		? { sources: [], context: "", notice }
		: { sources: [], context: "" };
}

/**
 * The project's threshold when the chat has a project, as generation
 * searches with; the default otherwise, or when the settings cannot be read.
 */
async function similarityThresholdFor(projectId?: string): Promise<number> {
	const fallback = getDefaultRagSettings().similarityThreshold;
	if (!projectId) {
		return fallback;
	}
	try {
		const settings = await getProjectRagSettings(projectId);
		return settings.similarityThreshold ?? fallback;
	} catch (error) {
		logger.warn(
			"[CompanyContext] Could not read the project's RAG settings; searching with the default threshold",
			{
				projectId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return fallback;
	}
}

/**
 * One call of the tool, as the chat's user. Never throws: no access, no
 * ready sources, no match and a timeout are all an empty result.
 */
export async function executeCompanyContextSearch(call: {
	userId: string;
	organizationId?: string;
	projectId?: string;
	/** From the model; anything but non-blank text searches nothing. */
	query: unknown;
}): Promise<CompanyContextToolResult> {
	const { userId, organizationId, projectId } = call;
	const query = typeof call.query === "string" ? call.query.trim() : "";
	if (!query) {
		return emptyResult();
	}

	// Asked again on every call: the turn's answer may be stale by now. The
	// threshold read depends on nothing the resolver decides and never throws,
	// so it runs alongside.
	const [access, minSimilarity] = await Promise.all([
		resolveCompanyContextChatAccess({
			userId,
			requestOrganizationId: organizationId,
			projectId,
		}),
		similarityThresholdFor(projectId),
	]);
	if (!access) {
		// The resolver has logged why.
		return emptyResult();
	}
	if (access.readySourceCount === 0) {
		logger.info(
			"[CompanyContext] Company context not searched for this chat",
			{
				userId,
				organizationId: access.organizationId,
				projectId,
				reason: "no-ready-sources",
			},
		);
		return emptyResult();
	}

	// The search logs the ids and hit count; never the query or the text.
	const { entries, timedOut } = await searchCompanyContext({
		organizationId: access.organizationId,
		userId,
		query,
		minSimilarity,
		timeoutMs: COMPANY_CONTEXT_SEARCH_TIMEOUT_MS,
		projectId,
		logContext: { surface: "advisor-chat", projectId },
	});
	if (timedOut) {
		return emptyResult(TIMEOUT_NOTICE);
	}
	if (entries.length === 0) {
		return emptyResult();
	}
	return {
		sources: entries.map((entry) => entry.sourceName),
		context: wrapUntrustedContext(
			"company_context",
			entries.map((entry) => entry.text).join("\n\n"),
		),
		guidance: RESULT_GUIDANCE,
	};
}

/**
 * The search tool, for a turn the Advisor opted in; nothing otherwise. The
 * user, organization and project are the chat's: the model supplies only the
 * query.
 */
export function createCompanyContextTools(
	options: CompanyContextToolOptions,
): Record<string, unknown> {
	if (options.companyContextAdvisor !== true) {
		return {};
	}
	const { userId, organizationId, projectId } = options;
	return {
		[COMPANY_CONTEXT_SEARCH_TOOL_NAME]: tool({
			description: COMPANY_CONTEXT_SEARCH_DESCRIPTION,
			inputSchema: jsonSchemaToZod(COMPANY_CONTEXT_SEARCH_INPUT_SCHEMA),
			execute: async (args: Record<string, unknown>) =>
				executeCompanyContextSearch({
					userId,
					organizationId,
					projectId,
					query: args.query,
				}),
		} as unknown as Parameters<typeof tool>[0]),
	};
}
