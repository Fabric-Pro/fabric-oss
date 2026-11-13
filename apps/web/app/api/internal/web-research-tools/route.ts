/**
 * Internal Web Research Endpoint
 *
 * Called by the document generator agent to search the web (`web_search`)
 * and read one public page (`read_url`) for a generation the user explicitly
 * allowed to research. The permission travels as the signed `wr` claim on the
 * AI token; the prompt and the request body cannot grant it.
 *
 * Checks, in order:
 * 1. the X-AI-Token verifies (401 INVALID_TOKEN);
 * 2. the token carries `wr` (403 RESEARCH_NOT_AUTHORIZED);
 * 3. the body is well formed (400 INVALID_REQUEST);
 * 4. the project is the one the permission was given for (when the token
 *    names one), the caller can reach it, it belongs to the token's
 *    organization and is not in the trash (403 PROJECT_ACCESS_DENIED);
 * 5. the action's research grant has calls left for the tool
 *    (429 RESEARCH_LIMIT_REACHED; when the limiter itself is unavailable the
 *    call proceeds and the outage is logged);
 * 6. the organization has a provider for the tool (409 RESEARCH_UNAVAILABLE),
 *    and the server can use it: its key decrypts and its settings build the
 *    provider (409 RESEARCH_PROVIDER_UNUSABLE);
 * 7. the query names none of the organization, project or client names and
 *    domains the filter knows (422 QUERY_REJECTED_CONFIDENTIAL);
 * 8. for `read_url`, the URL passes the URL policy (422 URL_NOT_ALLOWED).
 *
 * The organization comes only from the token. Every error is
 * `{ ok: false, code, message }` with a message safe to show the model. Logs
 * carry the tool, provider, code, duration, the read page's host and the
 * result count, never the query, a URL's path or query, or page text.
 */

import { AI_TOKEN_HEADER, verifyAIToken } from "@repo/ai-token";
import { checkRateLimit } from "@repo/api/lib/rate-limit";
import {
	getProjectAccessContext,
	incrementOrganizationSearchProviderUsage,
	isProjectSoftDeleted,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	getWebResearchScraper,
	getWebResearchSearcher,
	type WebResearchProviderUnavailable,
} from "@repo/temporal/activities";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
	type ConfidentialTermKind,
	findConfidentialMatch,
} from "./confidential-terms";
import { loadConfidentialMatcher } from "./load-confidential-terms";
import { errorClass, runReadUrl, runWebSearch } from "./research-calls";
import { checkResearchUrl, type UrlRejectionReason } from "./url-policy";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_QUERY_LENGTH = 400;
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_LIMIT = 8;

/**
 * Calls one research grant (one generation action) may make per tool. Twice
 * the agent's own per-run limits (5 searches, 8 page reads), so a retried
 * attempt still gets a full budget while a token replayed outside the agent
 * cannot run up provider costs without bound.
 */
const RESEARCH_CALL_CAPS = { web_search: 10, read_url: 16 } as const;
/** The window the caps count over: longer than any attempt and its retry. */
const RESEARCH_CALL_WINDOW_MS = 2 * 60 * 60 * 1000;

const requestSchema = z.discriminatedUnion("toolName", [
	z.object({
		toolName: z.literal("web_search"),
		projectId: z.string().min(1),
		args: z.object({
			query: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
			maxResults: z.number().optional(),
		}),
	}),
	z.object({
		toolName: z.literal("read_url"),
		projectId: z.string().min(1),
		args: z.object({ url: z.string().min(1) }),
	}),
]);

const MESSAGES = {
	INVALID_TOKEN: "The research request is not authenticated.",
	RESEARCH_NOT_AUTHORIZED:
		"External web research was not allowed for this action. Continue with the project's own context.",
	INVALID_REQUEST: `The request is malformed: toolName must be web_search or read_url, projectId is required, a query must be 1 to ${MAX_QUERY_LENGTH} characters, maxResults must be a number when given, and a url must be a string.`,
	PROJECT_ACCESS_DENIED: "This project is not available for research.",
	RESEARCH_LIMIT_REACHED:
		"This action's web research limit is reached. Do not call web_search or read_url again; work with the results and pages you already have.",
	PROVIDER_KEY_UNREADABLE:
		"The organization's research provider is configured but its API key cannot be used. An organization admin needs to re-enter the provider's key in the search provider settings. Continue without external research.",
	PROVIDER_UNUSABLE:
		"The organization's research provider is configured but cannot be used. An organization admin needs to fix this provider's settings in the search provider settings. Continue without external research.",
	SEARCH_UNAVAILABLE:
		"No usable web search provider is enabled for this organization. Continue without external research.",
	READ_UNAVAILABLE:
		"No usable page-reading provider is enabled for this organization. Continue without external research.",
	INTERNAL_ERROR: "The research request failed on the server.",
} as const;

const MATCH_LABELS: Record<ConfidentialTermKind, string> = {
	organization_name: "the organization's name",
	organization_slug: "the organization's short name",
	project_name: "the project's name",
	client_name: "the client's name",
	client_domain: "the client's domain",
	member_email_domain: "the organization's email domain",
};

const URL_REJECTION_MESSAGES: Record<UrlRejectionReason, string> = {
	too_long: "The URL is longer than 2,048 characters.",
	invalid: "The URL could not be parsed.",
	scheme: "Only http and https URLs can be read.",
	credentials: "URLs with a user name or password cannot be read.",
	ip_literal:
		"URLs that use an IP address instead of a host name cannot be read.",
	local_host: "Local and internal addresses cannot be read.",
	confidential_term:
		"The URL contains a confidential organization, project or client name or domain. Read public pages that do not identify them.",
};

interface CallLog {
	tool?: string;
	provider?: string;
	domain?: string;
	resultCount?: number;
	errorKind?: string;
}

function clampMaxResults(requested: number | undefined): number {
	if (requested === undefined) {
		return DEFAULT_MAX_RESULTS;
	}
	return Math.min(MAX_RESULTS_LIMIT, Math.max(1, Math.floor(requested)));
}

export async function POST(req: Request): Promise<Response> {
	const startedAt = Date.now();
	const log: CallLog = {};

	const respond = (status: number, code: string, body: object) => {
		logger[status >= 500 ? "error" : "info"]("[web-research-tools] call", {
			...log,
			code,
			status,
			durationMs: Date.now() - startedAt,
		});
		return NextResponse.json(body, { status });
	};
	const fail = (
		status: number,
		code: string,
		message: string,
		extra: Record<string, unknown> = {},
	) => respond(status, code, { ok: false, code, message, ...extra });
	// An enabled provider the server cannot use. Only an unreadable key is
	// fixed by re-entering it; any other cause is a settings problem.
	const failUnusable = (
		unusable: Extract<
			WebResearchProviderUnavailable,
			{ unavailable: "unusable" }
		>,
	) => {
		log.provider = unusable.providerName;
		log.errorKind = unusable.reason;
		return fail(
			409,
			"RESEARCH_PROVIDER_UNUSABLE",
			unusable.reason === "key_unreadable"
				? MESSAGES.PROVIDER_KEY_UNREADABLE
				: MESSAGES.PROVIDER_UNUSABLE,
		);
	};

	try {
		const aiToken = req.headers.get(AI_TOKEN_HEADER);
		if (!aiToken) {
			return fail(401, "INVALID_TOKEN", MESSAGES.INVALID_TOKEN);
		}
		const verified = await verifyAIToken(aiToken);
		if (!verified.valid) {
			return fail(401, "INVALID_TOKEN", MESSAGES.INVALID_TOKEN);
		}
		if (verified.claims.wr !== true) {
			return fail(
				403,
				"RESEARCH_NOT_AUTHORIZED",
				MESSAGES.RESEARCH_NOT_AUTHORIZED,
			);
		}

		const parsed = requestSchema.safeParse(
			await req.json().catch(() => null),
		);
		if (!parsed.success) {
			return fail(400, "INVALID_REQUEST", MESSAGES.INVALID_REQUEST);
		}
		const request = parsed.data;
		log.tool = request.toolName;

		// A permission given for one project does not carry over to another.
		const permittedProject = verified.claims.wrp;
		if (
			permittedProject !== undefined &&
			permittedProject !== request.projectId
		) {
			return fail(
				403,
				"PROJECT_ACCESS_DENIED",
				MESSAGES.PROJECT_ACCESS_DENIED,
			);
		}

		const userId = verified.claims.sub;
		const organizationId = verified.claims.org;
		// Organization is the only tenant context; a token without one is
		// refused rather than resolved as personal.
		if (!organizationId) {
			return fail(
				403,
				"PROJECT_ACCESS_DENIED",
				MESSAGES.PROJECT_ACCESS_DENIED,
			);
		}
		const [access, inTrash] = await Promise.all([
			getProjectAccessContext(request.projectId, userId),
			isProjectSoftDeleted(request.projectId),
		]);
		if (!access || access.organizationId !== organizationId || inTrash) {
			return fail(
				403,
				"PROJECT_ACCESS_DENIED",
				MESSAGES.PROJECT_ACCESS_DENIED,
			);
		}

		// The budget belongs to the action, not the token: every token minted
		// for it carries the same grant; a token from before grants existed
		// counts on its own nonce.
		const grantId = verified.claims.wrg ?? verified.claims.jti;
		const capKey = `web-research:${grantId}:${request.toolName}`;
		let limit: Awaited<ReturnType<typeof checkRateLimit>> | null = null;
		let limiterErrorKind: string | undefined;
		try {
			limit = await checkRateLimit(
				capKey,
				RESEARCH_CALL_CAPS[request.toolName],
				RESEARCH_CALL_WINDOW_MS,
			);
		} catch (error) {
			limiterErrorKind = errorClass(error);
		}
		if (!limit || limit.reason === "ratelimit-unavailable") {
			// Fails open: the agent's own per-run limits still hold, and a
			// limiter outage must not switch research off for everyone.
			logger.error("[web-research-tools] research cap unavailable", {
				tool: request.toolName,
				grantId,
				organizationId,
				projectId: request.projectId,
				...(limiterErrorKind && { errorKind: limiterErrorKind }),
			});
		} else if (!limit.allowed) {
			return fail(
				429,
				"RESEARCH_LIMIT_REACHED",
				MESSAGES.RESEARCH_LIMIT_REACHED,
			);
		}

		const scope = { organizationId, projectId: request.projectId };

		if (request.toolName === "web_search") {
			const resolved = await getWebResearchSearcher(
				userId,
				organizationId,
			);
			if ("unavailable" in resolved) {
				if (resolved.unavailable === "unusable") {
					return failUnusable(resolved);
				}
				return fail(
					409,
					"RESEARCH_UNAVAILABLE",
					MESSAGES.SEARCH_UNAVAILABLE,
				);
			}
			const { searcher } = resolved;
			log.provider = searcher.providerName;

			const matcher = await loadConfidentialMatcher(scope);
			const matchKind = findConfidentialMatch(
				request.args.query,
				matcher,
			);
			if (matchKind) {
				return fail(
					422,
					"QUERY_REJECTED_CONFIDENTIAL",
					`The query contains ${MATCH_LABELS[matchKind]}. Search for the public topic without organization, project or client names.`,
					{ matchKind },
				);
			}

			const outcome = await runWebSearch(
				searcher,
				request.args.query,
				clampMaxResults(request.args.maxResults),
			);
			if (!outcome.ok) {
				log.errorKind = outcome.logKind;
				return fail(outcome.status, outcome.code, outcome.message);
			}
			log.resultCount = outcome.results.length;

			try {
				await incrementOrganizationSearchProviderUsage({
					organizationId,
					providerName: searcher.providerName,
					cost: 0,
				});
			} catch (error) {
				logger.error("[web-research-tools] usage count failed", {
					errorKind: errorClass(error),
				});
			}

			return respond(200, "OK", outcome);
		}

		const resolved = await getWebResearchScraper({
			userId,
			organizationId,
		});
		if ("unavailable" in resolved) {
			if (resolved.unavailable === "unusable") {
				return failUnusable(resolved);
			}
			return fail(409, "RESEARCH_UNAVAILABLE", MESSAGES.READ_UNAVAILABLE);
		}
		const { scraper } = resolved;
		log.provider = scraper.providerName;

		const matcher = await loadConfidentialMatcher(scope);
		const policy = checkResearchUrl(request.args.url, matcher);
		if (!policy.allowed) {
			return fail(
				422,
				"URL_NOT_ALLOWED",
				URL_REJECTION_MESSAGES[policy.reason],
				{
					reason: policy.reason,
					...(policy.matchKind && { matchKind: policy.matchKind }),
				},
			);
		}
		log.domain = policy.url.hostname;

		const outcome = await runReadUrl(scraper, policy.url, matcher);
		if (!outcome.ok) {
			log.errorKind = outcome.logKind;
			return fail(outcome.status, outcome.code, outcome.message, {
				...(outcome.reason && { reason: outcome.reason }),
			});
		}
		log.resultCount = 1;
		return respond(200, "OK", outcome);
	} catch (error) {
		log.errorKind = errorClass(error);
		return fail(500, "INTERNAL_ERROR", MESSAGES.INTERNAL_ERROR);
	}
}
