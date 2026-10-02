/**
 * Company URL Crawl Gate Activity (URL Context Sources, Fizzy #2719)
 *
 * The first step of a company website crawl, before any map or scrape: may
 * this crawl run at all? `urlSourceCrawlWorkflow` schedules it only on its
 * company-owner branch, so no project history carries it and project
 * histories replay unchanged.
 *
 * A company crawl runs only when:
 *   - `COMPANY_CONTEXT` is on for the organization. Turning it off keeps every
 *     source, page and vector, and makes crawls — scheduled ones included —
 *     exit here without calling the crawler;
 *   - the source still exists and is not being deleted. A refresh schedule
 *     can fire after its source was deleted and before the schedule was (the
 *     reconciler removes it), or while the deletion is still running. A
 *     source a delete has tombstoned is also refused the crawl slot below,
 *     so a delete that lands after this check still stops the crawl;
 *   - no other crawl of the source is running. Every crawl, scheduled ones
 *     included, claims the source's crawl slot (`urlActiveWorkflowId`) here,
 *     and the one that cannot exits without a crawler call or a write, so two
 *     crawls never write the same pages. The API records a crawl it started
 *     in the same slot after the start, which may land before or after this
 *     claim: the claim accepts a slot that already names this crawl. A slot
 *     naming a crawl that has finished (one that died before freeing it) is
 *     taken over, so it cannot block the source for good;
 *   - the organization's embedding model can index company context. With no
 *     embedding provider, or a model whose vectors do not fit the company
 *     collection, every fetched page would be stored and never searchable.
 *
 * A crawl the API started (`initial`, `manual-resync`) left its source
 * PENDING or EXTRACTING. When the gate is off it is settled as CANCELLED, so
 * the source does not read as in flight forever and a re-sync is accepted
 * once the gate is back on. A scheduled run never touched the row and leaves
 * it alone. When the embedding model cannot index the source, the source is
 * marked FAILED with the reason, since none of its content can be retrieved
 * until the model is changed — except on a scheduled refresh of a source
 * that is COMPLETED and embedded: its pages and vectors are intact and stay
 * searchable once the model is back, so only the reason and the next refresh
 * time are recorded, as for a refresh that fails later on. A crawl that
 * found the slot taken writes nothing: the crawl holding it finalizes the
 * source.
 *
 * A single-page retry (`retry-single-page`) never finalizes the source, so it
 * does not claim the slot either; it only refuses to run beside another crawl.
 */
import { AIProviderNotConfiguredError } from "@repo/ai";
import {
	type CompanyLinkSourceCrawlState,
	type ExtractionStatus,
	isFeatureEnabled,
} from "@repo/database";
import {
	resolveCompanyEmbeddingModel,
	unsupportedEmbeddingModelMessage,
} from "@repo/rag";
import { ApplicationFailure } from "@temporalio/common";
import { getTemporalClient } from "../../client";
import {
	CONTEXT_OWNER_INVALID,
	type ContextOwner,
	companyContextOwnerOf,
} from "../../lib/context-owner";
import {
	type CompanyLinkCrawlStore,
	companyContextRowStore,
	companyLinkCrawlStore,
} from "../../lib/context-row-store";
import { cadenceNextFireUtc } from "../../schedules/url-source-schedule";
import { activityLogger } from "../lib/activity-logger";

/** Recorded on a crawl the API started while the gate was off. */
export const COMPANY_CONTEXT_DISABLED_CRAWL_MESSAGE =
	"Company context is turned off for this organization, so this website was not crawled. Re-sync it once company context is turned back on.";

/** Recorded on a company source or page when no embedding provider resolves. */
export const COMPANY_CRAWL_NO_EMBEDDING_PROVIDER_MESSAGE =
	"AI provider not configured. Configure an embedding provider in Settings → AI to enable retrieval for this context.";

/** The status a gated-off crawl the API started is settled with. */
const DISABLED_CRAWL_STATUS: ExtractionStatus = "CANCELLED";

/**
 * Whether a website source's index is intact as it stands: COMPLETED and
 * embedded. A crawl the API starts sets its source PENDING first, so a crawl
 * that finds its source like this is a scheduled refresh; one that fails or
 * cannot run keeps the source COMPLETED, recording only why.
 */
export function isCompletedAndEmbedded(
	state: Pick<CompanyLinkSourceCrawlState, "extractionStatus" | "embeddedAt">,
): boolean {
	return state.extractionStatus === "COMPLETED" && state.embeddedAt !== null;
}

export type CompanyUrlCrawlGateReason =
	| "company-context-disabled"
	| "source-missing"
	| "source-deleting"
	| "crawl-in-progress"
	| "embedding-unavailable";

export interface CompanyUrlCrawlGateActivityInput {
	contextId: string;
	/** Must name a company owner; the workflow calls this for no other. */
	owner: ContextOwner;
	userId: string | null;
	mode: "initial" | "manual-resync" | "scheduled" | "retry-single-page";
	/** The crawl's own workflow id, matched against the source's in-flight slot. */
	workflowId: string;
}

export interface CompanyUrlCrawlGateActivityOutput {
	proceed: boolean;
	reason?: CompanyUrlCrawlGateReason;
	/** What was recorded on the source, when the gate recorded anything. */
	message?: string;
}

export async function companyUrlCrawlGateActivity(
	input: CompanyUrlCrawlGateActivityInput,
): Promise<CompanyUrlCrawlGateActivityOutput> {
	const { contextId, userId, mode, workflowId } = input;
	const owner = companyContextOwnerOf(input.owner);
	if (!owner) {
		throw ApplicationFailure.nonRetryable(
			"The company crawl gate runs for a company context owner only",
			CONTEXT_OWNER_INVALID,
		);
	}
	const { organizationId } = owner;
	const crawls = companyLinkCrawlStore(owner);

	if (!(await isFeatureEnabled("COMPANY_CONTEXT", organizationId))) {
		const settle = mode === "initial" || mode === "manual-resync";
		const settled = settle
			? await crawls.releaseCrawl(contextId, {
					workflowId,
					status: DISABLED_CRAWL_STATUS,
					message: COMPANY_CONTEXT_DISABLED_CRAWL_MESSAGE,
				})
			: false;
		activityLogger.info(
			"Company context is off for the organization; crawl skipped",
			{ contextId, organizationId, mode, settled },
		);
		return {
			proceed: false,
			reason: "company-context-disabled",
			...(settled
				? { message: COMPANY_CONTEXT_DISABLED_CRAWL_MESSAGE }
				: {}),
		};
	}

	const source = await companyContextRowStore(owner).loadSource(contextId);
	if (!source) {
		activityLogger.info(
			"Company context source no longer exists; crawl skipped",
			{ contextId, organizationId, mode },
		);
		return { proceed: false, reason: "source-missing" };
	}
	if (source.deletingAt !== null) {
		activityLogger.info(
			"Company context source is being deleted; crawl skipped",
			{ contextId, organizationId, mode },
		);
		return { proceed: false, reason: "source-deleting" };
	}

	const slot = await takeCrawlSlot(
		crawls,
		contextId,
		workflowId,
		mode === "retry-single-page"
			? { claim: false, holder: source.urlActiveWorkflowId }
			: { claim: true },
	);
	if (!slot.taken) {
		if (slot.holder === null) {
			activityLogger.info(
				"Company context source no longer exists, or is being deleted; crawl skipped",
				{ contextId, organizationId, mode },
			);
			return { proceed: false, reason: "source-missing" };
		}
		activityLogger.info(
			"Another crawl of this company context source is running; crawl skipped",
			{ contextId, organizationId, mode, runningCrawl: slot.holder },
		);
		return { proceed: false, reason: "crawl-in-progress" };
	}

	let blocked: string | null = null;
	try {
		const model = await resolveCompanyEmbeddingModel({
			organizationId,
			userId: userId ?? "",
		});
		if (!model.supported) {
			blocked = unsupportedEmbeddingModelMessage(model);
		}
	} catch (error) {
		if (!(error instanceof AIProviderNotConfiguredError)) {
			throw error;
		}
		blocked = COMPANY_CRAWL_NO_EMBEDDING_PROVIDER_MESSAGE;
	}
	if (blocked) {
		// Read now that this crawl holds the slot, not from the row loaded
		// before: a re-sync the API has since set PENDING is no intact index.
		const state =
			mode === "scheduled" ? await crawls.getCrawlState(contextId) : null;
		const kept = state && isCompletedAndEmbedded(state) ? state : null;
		await crawls.finalizeCrawl(
			contextId,
			kept
				? {
						workflowId,
						extractionError: blocked,
						urlNextRefreshAt: cadenceNextFireUtc(
							kept.urlRefreshMode,
							new Date(),
						),
					}
				: { workflowId, status: "FAILED", extractionError: blocked },
		);
		activityLogger.warn(
			"Company context source cannot be indexed with the organization's embedding model; crawl skipped",
			{ contextId, organizationId, mode, keptCompleted: kept !== null },
		);
		return {
			proceed: false,
			reason: "embedding-unavailable",
			message: blocked,
		};
	}

	return { proceed: true };
}

/**
 * Make this crawl the only one running on the source. With `claim`, the slot
 * is claimed for it; without, it is only checked (a single-page retry). A
 * slot naming a crawl that has finished is taken over, or ignored when only
 * checking. When the slot is not this crawl's, `holder` is the running crawl
 * that holds it — or null when the source is gone or being deleted, which
 * no crawl may claim.
 */
async function takeCrawlSlot(
	crawls: CompanyLinkCrawlStore,
	contextId: string,
	workflowId: string,
	check: { claim: true } | { claim: false; holder: string | null },
): Promise<{ taken: true } | { taken: false; holder: string | null }> {
	if (!check.claim) {
		const { holder } = check;
		return holder === null ||
			holder === workflowId ||
			(await crawlHasFinished(holder))
			? { taken: true }
			: { taken: false, holder };
	}
	if (await crawls.claimCrawl(contextId, workflowId)) {
		return { taken: true };
	}
	const holder =
		(await crawls.getCrawlState(contextId))?.urlActiveWorkflowId ?? null;
	if (holder === null) {
		// Freed between the claim and the read, or the source is gone or
		// being deleted.
		return (await crawls.claimCrawl(contextId, workflowId))
			? { taken: true }
			: { taken: false, holder: null };
	}
	if (
		(await crawlHasFinished(holder)) &&
		(await crawls.claimCrawl(contextId, workflowId, { replacing: holder }))
	) {
		activityLogger.warn(
			"Took over the crawl slot of a company context source from a finished crawl",
			{ contextId, finishedCrawl: holder },
		);
		return { taken: true };
	}
	return { taken: false, holder };
}

/** Temporal statuses of a crawl that will never write again. */
const FINISHED_STATUSES: ReadonlySet<string> = new Set([
	"COMPLETED",
	"FAILED",
	"CANCELLED",
	"TERMINATED",
	"TIMED_OUT",
	"CONTINUED_AS_NEW",
]);

/**
 * Whether the crawl a slot names has finished, or never existed. Any status
 * that is not clearly closed, and any error but not-found, reads as still
 * running: a live crawl's slot must never be taken.
 */
async function crawlHasFinished(workflowId: string): Promise<boolean> {
	try {
		const client = await getTemporalClient();
		const { status } = await client.workflow
			.getHandle(workflowId)
			.describe();
		return FINISHED_STATUSES.has(status.name);
	} catch (error) {
		if (error instanceof Error && error.name === "WorkflowNotFoundError") {
			return true;
		}
		activityLogger.warn(
			"Could not tell whether a company crawl is still running; treating it as running",
			{
				workflowId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return false;
	}
}
