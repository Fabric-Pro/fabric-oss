/**
 * Starting company context ingestion (Fizzy #2719): file processing, text
 * embedding, deletion and website crawls.
 *
 * Company sources run through the same workflows as project contexts, told
 * apart by the owner on their input: `{ kind: "company", organizationId }`,
 * no `projectId`, and the source id as the context id. Every start picks its
 * queue through `contextOwnerTaskQueue`, which routes a company owner to
 * `COMPANY_CONTEXT_TASK_QUEUE` — only workers that know company context poll
 * it, so an older worker can never run a company job down the project path.
 *
 * Starts go by workflow name, as the project procedures' do, so this package
 * has no compile-time dependency on workflow modules.
 */

import { ORPCError } from "@orpc/server";
import {
	claimCompanyLinkSourceCrawl,
	getEnabledOrganizationSearchProviders,
	releaseCompanyContextSourceClaim,
	updateCompanyLinkSourceCrawlState,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	buildUrlSourceScheduleId,
	type CompanyContextOwner,
	contextOwnerTaskQueue,
	createUrlSourceSchedule,
	getScheduleClient,
	getTemporalClient,
	isScheduledMode,
	ScheduleAlreadyRunning,
	ScheduleNotFoundError,
} from "@repo/temporal";
import { decryptApiKey } from "@repo/utils";
import { withCorrelationMemo } from "../../../../../lib/temporal-correlation";
import {
	buildSearchProvidersSettingsPath,
	DEFAULT_MAX_PAGES,
	type ProviderNotConfiguredData,
	pickEnabledProvider,
	resolveOrgSlug,
	type UrlSourceProviderName,
} from "../../../../projects/procedures/contexts/process-context-link";
import {
	isWorkflowAlreadyStartedError,
	isWorkflowNotFoundError,
} from "../../../../projects/procedures/discovery/lib";

/**
 * The queue project context workflows start on. A company owner never uses
 * it: `contextOwnerTaskQueue` answers `COMPANY_CONTEXT_TASK_QUEUE` for one.
 */
const PROJECT_CONTEXT_TASK_QUEUE = "project-documents";

const FILE_PROCESSING_WORKFLOW = "projectContextProcessingWorkflow";
const EMBEDDING_WORKFLOW = "contextEmbeddingWorkflow";
const DELETION_WORKFLOW = "contextDeletionWorkflow";
const URL_CRAWL_WORKFLOW = "urlSourceCrawlWorkflow";

function companyOwner(organizationId: string): CompanyContextOwner {
	return { kind: "company", organizationId };
}

function companyTaskQueue(owner: CompanyContextOwner): string {
	return contextOwnerTaskQueue(owner, PROJECT_CONTEXT_TASK_QUEUE);
}

/**
 * True when Temporal no longer runs a workflow — it finished, or never
 * existed — so there is nothing left to cancel. Cancelling a closed workflow
 * answers "workflow execution already completed", as a `WorkflowNotFoundError`.
 */
export function isWorkflowGone(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	return (
		isWorkflowNotFoundError(error) ||
		/not\s*found/i.test(error.message) ||
		/already\s+completed/i.test(error.message)
	);
}

/** True when a start was refused because the same workflow id is running. */
export function isWorkflowAlreadyStarted(error: unknown): boolean {
	return (
		isWorkflowAlreadyStartedError(error) ||
		(error instanceof Error &&
			(error.message?.includes("already started") ||
				error.message?.includes("already exists")))
	);
}

/**
 * Extract and embed an uploaded file. The id is deterministic on a first
 * pass, so a repeated call finds the running workflow instead of starting a
 * second one; a retry (re-extract from the stored file) gets its own.
 */
export async function startCompanyFileProcessing(params: {
	sourceId: string;
	organizationId: string;
	userId: string;
	retry?: boolean;
}): Promise<{ workflowId: string }> {
	const { sourceId, organizationId, userId, retry = false } = params;
	const owner = companyOwner(organizationId);
	const workflowId = retry
		? `company-context-processing-${sourceId}-retry-${Date.now()}`
		: `company-context-processing-${sourceId}`;
	const client = await getTemporalClient();
	await client.workflow.start(
		FILE_PROCESSING_WORKFLOW,
		withCorrelationMemo({
			taskQueue: companyTaskQueue(owner),
			workflowId,
			args: [
				{
					contextId: sourceId,
					userId,
					organizationId,
					extractionStrategy: "local-only",
					...(retry ? { isRetry: true } : {}),
					owner,
				},
			],
		}),
	);
	return { workflowId };
}

/**
 * Embed the text a source holds on its own row — a pasted text, or a file
 * whose content was already extracted. The body is not passed: the activity
 * reads it back from the row, which keeps a long text out of the workflow
 * payload. Every pass replaces the source's earlier points.
 */
export async function startCompanyTextEmbedding(params: {
	sourceId: string;
	organizationId: string;
	userId: string;
	type: string;
	title: string | null;
}): Promise<{ workflowId: string }> {
	const { sourceId, organizationId, userId, type, title } = params;
	const owner = companyOwner(organizationId);
	const workflowId = `company-context-embedding-${sourceId}-${Date.now()}`;
	const client = await getTemporalClient();
	await client.workflow.start(
		EMBEDDING_WORKFLOW,
		withCorrelationMemo({
			taskQueue: companyTaskQueue(owner),
			workflowId,
			args: [
				{
					contextId: sourceId,
					userId,
					organizationId,
					type,
					metadata: title ? { sourceTitle: title } : undefined,
					reembed: true,
					owner,
				},
			],
		}),
	);
	return { workflowId };
}

/**
 * Delete a source durably. The row must still exist when this starts: the
 * activity removes the vectors, then the stored file, then the row, and needs
 * the row for the first two.
 *
 * The workflow id is deterministic per source, so a delete repeated while a
 * deletion runs finds that run instead of starting a second one beside it:
 * the start answers "already started", which is a success here —
 * `alreadyRunning` says so. Once a run has closed, the same id starts a new
 * one, which is how a source whose deletion gave up is deleted again.
 */
export async function startCompanyContextDeletion(params: {
	source: { id: string; type: string; qdrantId: string | null };
	organizationId: string;
	userId: string;
	contextName: string;
	deletedBy: string;
}): Promise<{ workflowId: string; alreadyRunning: boolean }> {
	const { source, organizationId, userId, contextName, deletedBy } = params;
	const owner = companyOwner(organizationId);
	const workflowId = `company-context-deletion-${source.id}`;
	const client = await getTemporalClient();
	try {
		await client.workflow.start(
			DELETION_WORKFLOW,
			withCorrelationMemo({
				taskQueue: companyTaskQueue(owner),
				workflowId,
				args: [
					{
						contextId: source.id,
						userId,
						organizationId,
						qdrantId: source.qdrantId ?? undefined,
						owner,
						metadata: {
							contextType: source.type,
							contextName,
							deletedBy,
						},
					},
				],
			}),
		);
	} catch (error) {
		if (isWorkflowAlreadyStarted(error)) {
			logger.info(
				`[CompanyContext] Deletion ${workflowId} of company source ${source.id} is already running`,
			);
			return { workflowId, alreadyRunning: true };
		}
		throw error;
	}
	return { workflowId, alreadyRunning: false };
}

// ============================================================================
// Website crawls
// ============================================================================

/** The scraper a crawl runs with, and its decrypted key. */
export interface CompanyCrawlProvider {
	providerName: UrlSourceProviderName;
	apiKey: string;
}

/**
 * The organization's scraper for a crawl of `scope`, chosen exactly as a
 * project's `processLink` chooses one, with the same BAD_REQUEST codes when
 * none is configured: any scrape-capable provider for a single page, a
 * crawl-capable one for a path prefix. Company context is organization-owned,
 * so only the organization's providers count.
 */
export async function resolveCompanyCrawlProvider(
	organizationId: string,
	scope: "SINGLE_PAGE" | "PATH_PREFIX",
): Promise<CompanyCrawlProvider> {
	const providers =
		await getEnabledOrganizationSearchProviders(organizationId);

	const notConfigured = async (
		code: ProviderNotConfiguredData["code"],
		message: string,
	): Promise<never> => {
		const data: ProviderNotConfiguredData = {
			code,
			settingsPath: buildSearchProvidersSettingsPath(
				await resolveOrgSlug(organizationId),
			),
		};
		throw new ORPCError("BAD_REQUEST", { message, data });
	};

	if (!pickEnabledProvider(providers, false)) {
		return notConfigured(
			"SCRAPE_PROVIDER_NOT_CONFIGURED",
			"Website sources need a search provider with scraping (Firecrawl, Jina, Tavily, or Exa). Configure one in Settings → Search Providers.",
		);
	}
	const chosen = pickEnabledProvider(providers, scope === "PATH_PREFIX");
	if (!chosen?.encryptedApiKey) {
		return notConfigured(
			"CRAWL_PROVIDER_NOT_CONFIGURED",
			"Path-prefix crawls currently require Firecrawl. Configure Firecrawl in Settings → Search Providers, or pick Single page.",
		);
	}

	const providerName = chosen.providerName as UrlSourceProviderName;
	try {
		return { providerName, apiKey: decryptApiKey(chosen.encryptedApiKey) };
	} catch (error) {
		logger.error(
			`[CompanyContext] Failed to decrypt the ${providerName} API key: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: `Failed to read ${providerName} API key`,
		});
	}
}

/** Why a crawl runs, as `urlSourceCrawlWorkflow` names it. */
type CompanyCrawlMode = "initial" | "manual-resync";

/** The LINK source fields a crawl start reads. */
export interface CompanyCrawlSource {
	id: string;
	sourceUrl: string;
	sourceTitle: string | null;
	urlScope: "SINGLE_PAGE" | "PATH_PREFIX" | null;
	urlMaxPages: number | null;
	urlRefreshMode: "ONCE" | "DAILY" | "WEEKLY" | "MONTHLY" | "LIVE" | null;
}

/**
 * Start a crawl of a LINK source and record its workflow id on the row, where
 * cancelling finds it (the crawl clears it when it finishes). The caller has
 * already set the source PENDING or EXTRACTING. A start that fails marks the
 * source FAILED so its state is accurate — unless a delete has tombstoned it
 * since, whose status stays — then throws.
 *
 * `manual-resync` re-embeds every page with the organization's current model
 * even when its content is unchanged, which is what re-processing needs.
 *
 * Workflow ids follow the project crawl's: `url-crawl-{id}` for the first
 * crawl, which a repeated start finds running, and `url-crawl-{id}-resync-{now}`
 * for a re-sync. Company sources and project contexts both take cuid ids, so
 * the two never share a workflow id.
 */
export async function startCompanyUrlCrawl(params: {
	source: CompanyCrawlSource;
	organizationId: string;
	userId: string;
	provider: CompanyCrawlProvider;
	mode: CompanyCrawlMode;
}): Promise<{ workflowId: string }> {
	const { source, organizationId, userId, provider, mode } = params;
	const owner = companyOwner(organizationId);
	const workflowId =
		mode === "initial"
			? `url-crawl-${source.id}`
			: `url-crawl-${source.id}-resync-${Date.now()}`;
	try {
		const client = await getTemporalClient();
		await client.workflow.start(
			URL_CRAWL_WORKFLOW,
			withCorrelationMemo({
				taskQueue: companyTaskQueue(owner),
				workflowId,
				args: [
					{
						contextId: source.id,
						url: source.sourceUrl,
						scope: source.urlScope ?? "SINGLE_PAGE",
						maxPages: source.urlMaxPages ?? DEFAULT_MAX_PAGES,
						userId,
						organizationId,
						apiKey: provider.apiKey,
						providerName: provider.providerName,
						urlRefreshMode: source.urlRefreshMode ?? undefined,
						parentSourceTitle: source.sourceTitle ?? null,
						mode,
						owner,
					},
				],
			}),
		);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unknown error";
		logger.error(
			`[CompanyContext] Failed to start the crawl for company source ${source.id}: ${message}`,
		);
		await releaseCompanyContextSourceClaim({
			id: source.id,
			organizationId,
			status: "FAILED",
			extractionError: `Failed to start crawl: ${message}`,
		}).catch((updateError) => {
			logger.error(
				`[CompanyContext] Failed to mark company source ${source.id} FAILED: ${updateError}`,
			);
		});
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: `Failed to start the website scan: ${message}`,
		});
	}

	// After the start, and outside its failure path: the crawl is running
	// whether or not this write lands, so a failure here must not mark the
	// source FAILED. It only leaves the crawl without a cancel handle.
	//
	// The crawl claims the same slot itself, so the two writes race. This one
	// lands only while the slot is free or already this crawl's, and the
	// source is still queued or crawling: it never overwrites another crawl's
	// claim, and never refills the slot of a crawl that already finished —
	// nothing would clear it again, and the source would read as in flight.
	await claimCompanyLinkSourceCrawl({
		id: source.id,
		organizationId,
		workflowId,
		onlyWhileInFlight: true,
	})
		.then((claimed) => {
			if (!claimed) {
				logger.debug(
					`[CompanyContext] Crawl ${workflowId} not recorded on company source ${source.id}: another crawl holds its slot, or it already finished`,
				);
			}
		})
		.catch((stampError) => {
			logger.error(
				`[CompanyContext] Failed to record crawl ${workflowId} on company source ${source.id}: ${stampError}`,
			);
		});
	logger.info(
		`[CompanyContext] Started ${URL_CRAWL_WORKFLOW} (${mode}) for company source ${source.id} as ${workflowId}`,
	);
	return { workflowId };
}

/**
 * Why a website's refresh schedule could not be set up, returned beside a
 * crawl that did start. The source then records no schedule, so it never
 * claims a refresh that will not fire; re-syncing it tries again.
 */
export interface CompanyScheduleWarning {
	code: "REFRESH_SCHEDULE_NOT_CREATED";
	message: string;
}

const SCHEDULE_NOT_CREATED: CompanyScheduleWarning = {
	code: "REFRESH_SCHEDULE_NOT_CREATED",
	message:
		"The website is being crawled, but its automatic refresh could not be scheduled. Re-sync the website to try again.",
};

/** A source whose refresh schedule is being set up. */
type ScheduledCrawlSource = CompanyCrawlSource & {
	urlRefreshMode: "DAILY" | "WEEKLY" | "MONTHLY";
};

function hasScheduledRefresh(
	source: CompanyCrawlSource,
): source is ScheduledCrawlSource {
	return isScheduledMode(source.urlRefreshMode);
}

/**
 * Create the refresh schedule of a DAILY / WEEKLY / MONTHLY source; a source
 * with another cadence has none, and gets `undefined`.
 *
 * The schedule id is deterministic, and recorded on the source BEFORE the
 * schedule is created: the reconciliation sweep deletes a schedule its source
 * does not record, and would otherwise delete this one in the moment between
 * its creation and the write. A creation that fails clears the id again and
 * comes back as a warning — the sweep only removes schedules, it never
 * creates a missing one, so a failure left silent would leave the source
 * claiming a refresh that never fires. A schedule that already exists under
 * the id is this source's, and is kept.
 */
export async function scheduleCompanyUrlRefresh(params: {
	source: CompanyCrawlSource;
	organizationId: string;
	userId: string;
	provider: CompanyCrawlProvider;
}): Promise<CompanyScheduleWarning | undefined> {
	const { source, organizationId, userId, provider } = params;
	if (!hasScheduledRefresh(source)) {
		return undefined;
	}
	const scheduleId = buildUrlSourceScheduleId(source.id);
	const describeError = (error: unknown) =>
		error instanceof Error ? error.message : String(error);

	try {
		const recorded = await updateCompanyLinkSourceCrawlState(
			source.id,
			organizationId,
			{ urlScheduleId: scheduleId },
		);
		if (!recorded) {
			// The source is gone; a schedule would only fire against nothing.
			logger.warn(
				`[CompanyContext] Company source ${source.id} no longer exists; not scheduling its refresh`,
			);
			return undefined;
		}
	} catch (error) {
		logger.error(
			`[CompanyContext] Failed to record the refresh schedule of company source ${source.id}: ${describeError(error)}`,
		);
		return SCHEDULE_NOT_CREATED;
	}

	try {
		const scheduleClient = await getScheduleClient();
		await createUrlSourceSchedule(
			{
				contextId: source.id,
				url: source.sourceUrl,
				scope: source.urlScope ?? "SINGLE_PAGE",
				maxPages: source.urlMaxPages ?? DEFAULT_MAX_PAGES,
				userId,
				organizationId,
				apiKey: provider.apiKey,
				providerName: provider.providerName,
				refreshMode: source.urlRefreshMode,
				parentSourceTitle: source.sourceTitle ?? null,
				owner: companyOwner(organizationId),
			},
			scheduleClient,
		);
		return undefined;
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			logger.info(
				`[CompanyContext] Refresh schedule ${scheduleId} of company source ${source.id} already exists; keeping it`,
			);
			return undefined;
		}
		logger.error(
			`[CompanyContext] Failed to create the refresh schedule for company source ${source.id}: ${describeError(error)}`,
		);
		await updateCompanyLinkSourceCrawlState(source.id, organizationId, {
			urlScheduleId: null,
		}).catch((clearError) => {
			// The id stays without a schedule; a re-sync finds it missing and
			// creates it.
			logger.error(
				`[CompanyContext] Failed to clear the refresh schedule id of company source ${source.id}: ${describeError(clearError)}`,
			);
		});
		return SCHEDULE_NOT_CREATED;
	}
}

/**
 * Make sure a DAILY / WEEKLY / MONTHLY source has its refresh schedule, for a
 * re-sync: the repair path for a schedule whose creation failed, or that went
 * missing after its id was recorded. A recorded schedule Temporal still knows
 * is left as it is; one it does not know, or no recorded id at all, is
 * created as `scheduleCompanyUrlRefresh` creates it.
 *
 * A schedule that cannot be checked for another reason is assumed present:
 * the source records it, and this path only repairs what it can see missing.
 */
export async function ensureCompanyUrlRefreshSchedule(params: {
	source: CompanyCrawlSource & { urlScheduleId: string | null };
	organizationId: string;
	userId: string;
	provider: CompanyCrawlProvider;
}): Promise<CompanyScheduleWarning | undefined> {
	const { source } = params;
	if (!hasScheduledRefresh(source)) {
		return undefined;
	}
	if (source.urlScheduleId) {
		try {
			const scheduleClient = await getScheduleClient();
			await scheduleClient.getHandle(source.urlScheduleId).describe();
			return undefined;
		} catch (error) {
			if (!(error instanceof ScheduleNotFoundError)) {
				logger.warn(
					`[CompanyContext] Could not check the refresh schedule ${source.urlScheduleId} of company source ${source.id}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				return undefined;
			}
			logger.warn(
				`[CompanyContext] Refresh schedule ${source.urlScheduleId} of company source ${source.id} is missing; creating it`,
			);
		}
	}
	return scheduleCompanyUrlRefresh(params);
}
